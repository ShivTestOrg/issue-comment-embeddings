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

  // If alwaysRecommend is enabled, use a lower threshold to ensure we get enough recommendations
  const threshold = context.config.alwaysRecommend && context.config.alwaysRecommend > 0 ? 0 : context.config.jobMatchingThreshold;

  const similarIssues = await supabase.issue.findSimilarIssuesToMatch({
    markdown: issueContent,
    threshold: threshold,
    currentId: issue.node_id,
  });

  const similarIssuesMatched = await findSimilarIssuesToMatch(payload, similarIssues, logger, octokit, context.config);

  if (similarIssuesMatched instanceof Map) {
    if (similarIssuesMatched.size > 0) {
      logger.info("Possible Suggestion for contributors", {
        similarIssues: Array.from(similarIssuesMatched),
      });
    } else {
      logger.info("No Contributors recommended for this issue", {
        issue: payload.issue,
      });
    }
  }

  logger.info(`Exiting issueMatching handler!`, { similarIssues: similarIssues || "No similar issues found" });
}

/**
 * Finds similar issues and returns either a map of contributor details or a formatted comment string
 * @param payload The issue payload containing issue details and repository info
 * @param similarIssues Array of similar issues found
 * @param logger Logger instance
 * @param octokit Octokit instance
 * @param config Configuration object
 * @param returnRawMap If true, returns raw Map of contributor details; if false, returns formatted comment string
 * @returns Map<string, Array<string>> | string
 */

export interface IssueRawData {
  similarityPercentage: string;
  ownerLogin: string;
  repoName: string;
  issueNumber: string;
  issueLink: string;
}

export async function findSimilarIssuesToMatch(
  payload: {
    issue: {
      number: number;
      node_id: string;
    };
    repository: {
      owner: {
        login: string;
      };
      name: string;
    };
  },
  similarIssues: IssueSimilaritySearchResult[] | null,
  logger: Context["logger"],
  octokit: Context["octokit"],
  config: Partial<Context["config"]>,
  returnRawMap: boolean = false
): Promise<Map<string, Array<IssueRawData>>> {
  const matchResultArray = new Map<string, Array<IssueRawData>>();
  if (similarIssues && similarIssues.length > 0) {
    similarIssues.sort((a: IssueSimilaritySearchResult, b: IssueSimilaritySearchResult) => b.similarity - a.similarity); // Sort by similarity
    const fetchPromises = similarIssues.map(async (issue: IssueSimilaritySearchResult) => {
      try {
        const issueObject: IssueGraphqlResponse = await octokit.graphql(
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
        logger.error(`Failed to fetch issue ${issue.issue_id}: ${error}`, { issue });
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
          const issueLink = issue.node.url.replace(/https?:\/\/github.com/, "https://www.github.com");
          const issueNumber = issue.node.url.split("/").pop() || "";
          const similarityPercentage = Math.round(issue.similarity * 100);
          const rawData = {
            similarityPercentage: similarityPercentage.toString(),
            ownerLogin: issue.node.repository.owner.login,
            repoName: issue.node.repository.name,
            issueNumber,
            issueLink,
          };
          if (matchResultArray.has(assignee.login)) {
            matchResultArray.get(assignee.login)?.push(rawData);
          } else {
            matchResultArray.set(assignee.login, [rawData]);
          }
        });
      }
    });
  }
  if (returnRawMap) {
    return matchResultArray;
  }
  const formattedMap = new Map<string, Array<string>>();
  matchResultArray.forEach((issues, assignee) => {
    const formattedIssues = issues.map(
      (issue) => `> \`${issue.similarityPercentage}% Match\` [${issue.ownerLogin}/${issue.repoName}#${issue.issueNumber}](${issue.issueLink})`
    );
    formattedMap.set(assignee, formattedIssues);
  });

  await issueMatchingCommentHandler(payload, config, octokit, logger, formattedMap, ">The following contributors may be suitable for this task:");
  return matchResultArray;
}

async function issueMatchingCommentHandler(
  payload: {
    issue: {
      number: number;
      node_id: string;
    };
    repository: {
      owner: {
        login: string;
      };
      name: string;
    };
  },
  config: Partial<Context["config"]>,
  octokit: Context["octokit"],
  logger: Context["logger"],
  matchResultArray: Map<string, Array<string>>,
  commentStart: string
) {
  const issue = payload.issue;

  // Fetch if any previous comment exists
  const listIssues: RestEndpointMethodTypes["issues"]["listComments"]["response"] = await octokit.rest.issues.listComments({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: issue.number,
  });
  //Check if the comment already exists
  const existingComment = listIssues.data.find((comment) => comment.body && comment.body.includes(">[!NOTE]" + "\n" + commentStart));

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
  const numToShow = config.alwaysRecommend || 3;
  const limitedContributors = new Map(sortedContributors.slice(0, numToShow).map(({ login, matches }) => [login, matches]));

  const comment = commentBuilder(limitedContributors);

  logger.debug("Comment to be added", { comment });

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      comment_id: existingComment.id,
      body: comment,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: comment,
    });
  }
}

/**
 * Builds the comment to be added to the issue
 * @param matchResultArray The array of issues to be matched
 * @returns The comment to be added to the issue
 */
function commentBuilder(matchResultArray: Map<string, Array<string>>): string {
  const commentLines: string[] = [">[!NOTE]", ">The following contributors may be suitable for this task:"];
  matchResultArray.forEach((issues: Array<string>, assignee: string) => {
    commentLines.push(`>### [${assignee}](https://www.github.com/${assignee})`);
    issues.forEach((issue: string) => {
      commentLines.push(issue);
    });
  });
  return commentLines.join("\n");
}
