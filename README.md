# `@ubiquity-os/issue-comment-embeddings`

This is a plugin for [Ubiquibot](https://github.com/ubiquity-os/ubiquity-os-kernel). It listens for issue comments, and adds them to a vector store. It handles comment edits and deletions as well.

## Configuration

- Host the plugin on a server that Ubiquibot can access.
  To set up the `.dev.vars` file, you will need to provide the following variables:
- `SUPABASE_URL`: The URL for your Supabase instance.
- `SUPABASE_KEY`: The key for your Supabase instance.
- `VOYAGEAI_API_KEY`: The API key for Voyage.

## Usage

- Add the following to your `.ubiquity-os.config.yml` file with the appropriate URL:

```yaml
- plugin: https://ubiquity-os-comment-vector-embeddings-main.ubiquity.workers.dev
  with:
    dedupeMatchThreshold: 0.95
    dedupeWarningThreshold: 0.75
    annotateThreshold: 0.65
    jobMatchingThreshold: 0.75
```

## Testing Locally

- Run `bun install` to install the dependencies.
- Run `bun worker` to start the server.
- Make HTTP requests to the server to test the plugin with content type `Application/JSON`

```
{
    "stateId": "",
    "eventName": "issue_comment.created",
    "eventPayload": {
        "comment": {
            "user": {
                "login" : "COMMENTER"
            },
            "body": "<COMMENT_BODY>" ,
            "id": <UNIQUE_COMMENT_ID>
        },
        "repository" : {
            "name" : "REPONAME",
            "owner":{
                "login" : "USERNAME"
            }
        },
        "issue": {
            "number": <ISSUE_NUMBER>,
            "body": "<ISSUE_TEXT>"
        }
    },
    "env": {},
    "settings": {},
    "ref": "",
    "authToken": ""
}
```

- Replace the placeholders with the appropriate values.

## Testing

- Run `bun run test` to run the tests.

## Technical Implementation Details

This implementation leverages vector embeddings for intelligent issue management, combining modern NLP techniques with robust data storage to create a sophisticated issue tracking and deduplication system.

### Architecture Overview

The system is built as a plugin that processes GitHub issues and comments through a series of specialized handlers. At its core, it uses two main services:

1. Voyage AI for generating text embeddings
2. Supabase for storing and querying vector embeddings

The plugin architecture is elegantly structured to handle various GitHub events:

```typescript
if (isIssueCommentEvent(context)) {
  switch (eventName) {
    case "issue_comment.created":
      return await addComments(context);
    case "issue_comment.deleted":
      return await deleteComment(context);
    case "issue_comment.edited":
      return await updateComment(context);
  }
} else if (isIssueEvent(context)) {
  switch (eventName) {
    case "issues.opened":
      await addIssue(context);
      await issueMatching(context);
      return await issueChecker(context);
    // ... other issue events
  }
}
```

### Vector Embeddings: The Core Technology

The most fascinating aspect of this system is its use of vector embeddings to understand and process text. The implementation uses Voyage AI's embedding service with their large instruction model:

```typescript
async createEmbedding(text: string | null, inputType: EmbedRequestInputType = "document"): Promise<number[]> {
  if (text === null) {
    throw new Error("Text is null");
  } else {
    const response = await this.client.embed({
      input: text,
      model: "voyage-large-2-instruct",
      inputType,
    });
    return (response.data && response.data[0]?.embedding) || [];
  }
}
```

This converts text into high-dimensional vectors that capture semantic meaning, allowing for sophisticated similarity comparisons between issues.

### Intelligent Issue Management

The system implements several advanced features for issue management:

#### 1. Issue Deduplication

One of the most powerful features is the ability to find similar issues using vector similarity search. The implementation uses a custom-implemented vector similarity search:

```typescript
async findSimilarIssues({ markdown, currentId, threshold }: FindSimilarIssuesParams): Promise<IssueSimilaritySearchResult[] | null> {
  const embedding = await this.context.adapters.voyage.embedding.createEmbedding(markdown);
  const { data, error } = await this.supabase.rpc("find_similar_issues", {
    query_embedding: embedding,
    current_id: currentId,
    threshold,
    top_k: 5,
  });
  // ... error handling
  return data;
}
```

This allows the system to:

- Detect duplicate issues automatically
- Find related issues based on content similarity
- Maintain a clean issue tracker by preventing redundancy

#### 2. Secure Storage for Private Issues

The system implements privacy-conscious storage of issue data:

```typescript
if (isPrivate) {
  finalMarkdown = null;
  finalPayload = null;
  plaintext = null;
}

const { data, error } = await this.supabase.from("issues").insert([
  {
    id: issueData.id,
    plaintext,
    embedding,
    payload: finalPayload,
    author_id: issueData.author_id,
    markdown: finalMarkdown,
  },
]);
```

This ensures that private issues are handled appropriately while still maintaining the vector embedding functionality.

#### 3. Real-time Updates

The system maintains consistency by updating embeddings whenever issues are modified:

```typescript
async updateIssue(issueData: IssueData) {
  const embedding = Array.from(await this.context.adapters.voyage.embedding.createEmbedding(issueData.markdown));
  // ... privacy handling
  const { error } = await this.supabase
    .from("issues")
    .update({
      markdown: finalMarkdown,
      plaintext,
      embedding,
      payload: finalPayload,
      modified_at: new Date(),
    })
    .eq("id", issueData.id);
}
```

This ensures that the semantic understanding of issues stays current even as their content evolves.

### Technical Implementation Benefits

1. **Scalability**: The use of Supabase for vector storage and similarity search means the system can handle large numbers of issues efficiently.

2. **Accuracy**: By using Voyage AI's large instruction model for embeddings, the system achieves high-quality semantic understanding of issue content.

3. **Maintainability**: The modular architecture with separate handlers for different events makes the code easy to maintain and extend.

4. **Real-time Processing**: The system processes issues and comments in real-time, providing immediate feedback on duplicates and similar issues.

This implementation showcases how modern NLP techniques can be practically applied to improve developer workflows. By combining vector embeddings with efficient storage and similarity search, it creates a powerful system for managing and organizing issues intelligently.
