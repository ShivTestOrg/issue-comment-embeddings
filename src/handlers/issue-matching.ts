import { Context } from "../types";
import { IssueSimilaritySearchResult } from "../adapters/supabase/helpers/issues";
import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";

export interface IssueGraphqlResponse {
  node: {
    title: string;
    url: string;
    state: string;
    stateReason: string;
    closed: boolean;
    repository: {
      owner: {
        login: string;
      };
      name: string;
    };
    assignees: {
      nodes: Array<{
        login: string;
        url: string;
      }>;
    };
  };
  similarity: number;
}

/**
 * Checks if the current issue is a duplicate of an existing issue.
 * If a similar completed issue is found, it will add a comment to the issue with the assignee(s) of the similar issue.
 * @param context The context object
 **/
export async function issueMatching(context: Context<"issues.opened" | "issues.edited" | "issues.labeled">) {
  const {
    logger,
    adapters: { supabase },
    octokit,
    payload,
  } = context;
  const issue = payload.issue;
  const issueContent = issue.body + issue.title;
  const matchResultArray: Map<string, Array<string>> = new Map();

  // If alwaysRecommend is enabled, use a lower threshold to ensure we get enough recommendations
  const threshold = context.config.alwaysRecommend && context.config.alwaysRecommend > 0 ? 0 : context.config.jobMatchingThreshold;

  const similarIssues = await supabase.issue.findSimilarIssuesToMatch({
    markdown: issueContent,
    threshold: threshold,
    currentId: issue.node_id,
  });

  if (similarIssues && similarIssues.length > 0) {
    similarIssues.sort((a: IssueSimilaritySearchResult, b: IssueSimilaritySearchResult) => b.similarity - a.similarity); // Sort by similarity
    const fetchPromises = similarIssues.map(async (issue: IssueSimilaritySearchResult) => {
      try {
        const issueObject: IssueGraphqlResponse = await context.octokit.graphql(
          /* GraphQL */
          `
            query ($issueNodeId: ID!) {
              node(id: $issueNodeId) {
                ... on Issue {
                  title
                  url
                  state
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                  stateReason
                  closed
                  assignees(first: 10) {
                    nodes {
                      login
                      url
                    }
                  }
                }
              }
            }
          `,
          { issueNodeId: issue.issue_id }
        );
        issueObject.similarity = issue.similarity;
        return issueObject;
      } catch (error) {
        context.logger.error(`Failed to fetch issue ${issue.issue_id}: ${error}`, { issue });
        return null;
      }
    });
    const issueList = await Promise.allSettled(fetchPromises);

    logger.debug("Fetched similar issues", { issueList });
    issueList.forEach((issuePromise: PromiseSettledResult<IssueGraphqlResponse | null>) => {
      if (!issuePromise || issuePromise.status === "rejected" || !issuePromise.value) {
        return;
      }
      const issue = issuePromise.value as IssueGraphqlResponse;
      // Only use completed issues that have assignees
      if (issue.node.closed && issue.node.stateReason === "COMPLETED" && issue.node.assignees.nodes.length > 0) {
        const assignees = issue.node.assignees.nodes;
        assignees.forEach((assignee: { login: string; url: string }) => {
          const similarityPercentage = Math.round(issue.similarity * 100);
          const issueLink = issue.node.url.replace(/https?:\/\/github.com/, "https://www.github.com");
          if (matchResultArray.has(assignee.login)) {
            matchResultArray
              .get(assignee.login)
              ?.push(
                `> \`${similarityPercentage}% Match\` [${issue.node.repository.owner.login}/${issue.node.repository.name}#${issue.node.url.split("/").pop()}](${issueLink})`
              );
          } else {
            matchResultArray.set(assignee.login, [
              `> \`${similarityPercentage}% Match\` [${issue.node.repository.owner.login}/${issue.node.repository.name}#${issue.node.url.split("/").pop()}](${issueLink})`,
            ]);
          }
        });
      }
    });

    // Fetch if any previous comment exists
    const listIssues: RestEndpointMethodTypes["issues"]["listComments"]["response"] = await octokit.rest.issues.listComments({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: issue.number,
    });

    // Use a unique identifier in HTML comment to prevent double posting
    const commentIdentifier = `<!--issue-matching-${payload.issue.node_id}-->`;
    const existingComment = listIssues.data.find((comment) => comment.body && comment.body.includes(commentIdentifier));

    logger.debug("Matched issues", { matchResultArray, length: matchResultArray.size });

    if (matchResultArray.size === 0) {
      if (existingComment) {
        // If the comment already exists, delete it
        await octokit.rest.issues.deleteComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          comment_id: existingComment.id,
        });
      }
      logger.debug("No suitable contributors found");
      return;
    }

    // Convert Map to array and sort by highest similarity
    const sortedContributors = Array.from(matchResultArray.entries())
      .map(([login, matches]) => ({
        login,
        matches,
        maxSimilarity: Math.max(...matches.map((match) => parseInt(match.match(/`(\d+)% Match`/)?.[1] || "0"))),
      }))
      .sort((a, b) => b.maxSimilarity - a.maxSimilarity);

    logger.debug("Sorted contributors", { sortedContributors });

    // Use alwaysRecommend if specified
    const numToShow = context.config.alwaysRecommend || 3;
    const limitedContributors = new Map(sortedContributors.slice(0, numToShow).map(({ login, matches }) => [login, matches]));

    const comment = commentBuilder(limitedContributors, issue.node_id);

    logger.debug("Comment to be added", { comment });

    if (existingComment) {
      await context.octokit.rest.issues.updateComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        comment_id: existingComment.id,
        body: comment,
      });
    } else {
      await context.octokit.rest.issues.createComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.issue.number,
        body: comment,
      });
    }
  }

  logger.info(`Exiting issueMatching handler!`, { similarIssues: similarIssues || "No similar issues found" });
}

/**
 * Builds the comment to be added to the issue
 * @param matchResultArray The array of issues to be matched
 * @param issueId The node ID of the current issue
 * @returns The comment to be added to the issue
 */
function commentBuilder(matchResultArray: Map<string, Array<string>>, issueId: string): string {
  const commentLines: string[] = [`<!--issue-matching-${issueId}-->`, ">[!NOTE]", ">The following contributors may be suitable for this task:"];
  matchResultArray.forEach((issues: Array<string>, assignee: string) => {
    commentLines.push(`>### [${assignee}](https://www.github.com/${assignee})`);
    issues.forEach((issue: string) => {
      commentLines.push(issue);
    });
  });
  return commentLines.join("\n");
}
