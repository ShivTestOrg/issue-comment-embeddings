import { Context } from "../types";
import { removeFootnotes } from "./issue-deduplication";

export async function addIssue(context: Context<"issues.opened">) {
  const {
    logger,
    adapters: { supabase },
    payload,
  } = context;
  const issue = payload.issue;
  const markdown = payload.issue.body && payload.issue.title ? `${payload.issue.body} ${payload.issue.title}` : null;
  const authorId = issue.user?.id || -1;
  const id = issue.node_id;
  const isPrivate = payload.repository.private;

  try {
    if (!markdown) {
      logger.error("Issue body is empty", { issue });
      return;
    }
    const cleanedIssue = removeFootnotes(markdown);
    const shouldRedact = context.settings.enableRedaction ?? true;
    const effectiveIsPrivate = shouldRedact && isPrivate;
    await supabase.issue.createIssue({ id, payload, isPrivate: effectiveIsPrivate, markdown: cleanedIssue, author_id: authorId });
    logger.ok(`Successfully created issue!`, issue);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error creating issue:`, { error: error, issue: issue });
      throw error;
    } else {
      logger.error(`Error creating issue:`, { err: error, issue: issue });
      throw error;
    }
  }
  logger.debug(`Exiting addIssue`);
}
