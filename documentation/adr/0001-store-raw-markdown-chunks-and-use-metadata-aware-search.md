# Store raw markdown chunks and use metadata-aware search

## Status

Proposed

## Context

Vaultgentic turns markdown notes into searchable chunks. Those chunks are used for keyword search, semantic search, hybrid ranking, snippets, and `read <chunk-id>`.

The current model mixes two different concerns into one field: user-authored content and generated context. Chunk text may include synthetic lines such as title, path, headings, and tags before the markdown body. That makes search recall easier because every chunk carries its surrounding metadata, but it also means the content returned by `read <chunk-id>` is not necessarily the content the user wrote.

This became visible when search results returned chunk IDs that appeared relevant because their title, path, or heading matched the query, but reading the chunks showed little or no body content. In some cases the chunk was effectively only metadata plus a markdown heading. That defeats the purpose of returning chunk IDs: a chunk ID should identify a useful piece of note content.

The key issue is separation of responsibilities:

- Metadata such as title, path, headings, aliases, and tags is valuable for relevance and context.
- Body content is what users expect to read, quote, inspect, and act on.
- Search may need metadata-enriched input for accuracy, especially for short or ambiguous note sections.
- Display and read operations should not expose generated search scaffolding as if it were note content.

Titles and headings should still matter. A section under “Backup Flow” should rank well for backup-related searches even if the body uses more specific terms. But title and heading matches should explain or improve relevance, not fabricate chunks that contain no useful body content.

We also want this decision to remain simple enough to implement and maintain. Adding multiple persisted representations of the same text, complex snippet reconstruction, or broad schema changes would increase the risk of confusing future behavior. The design should use structured metadata deliberately while keeping stored chunk content honest.

## Decision

Store chunk text as raw user-authored markdown only.

Do not prefix stored chunk text with generated title, path, heading, tag, or other metadata lines. Metadata remains available as structured data and may still be shown separately in CLI output, used in ranking, or used to build search inputs.

Chunk IDs should identify readable markdown content. `read <chunk-id>` should therefore return the markdown excerpt represented by that chunk, not a generated search document.

Do not emit chunks that contain no meaningful body content. A markdown heading may be included in a chunk when it introduces body content, but a standalone heading must not become a searchable/readable chunk by itself.

Use metadata-aware search rather than metadata-polluted storage:

- Keyword search should use structured fields such as title, heading path, and body text intentionally.
- Chunk-level keyword results should come from body or heading relevance, not title-only matches repeated across every chunk in a note.
- Title-only matches should be represented as note-level results, without pretending that a specific body chunk matched.
- Semantic embedding input may include controlled metadata context, such as title and heading path, to preserve retrieval accuracy for short or ambiguous chunks.
- Generated embedding/search input must not be stored as the readable chunk body or exposed directly by `read <chunk-id>`.

This creates two conceptual representations:

- **Readable chunk text:** raw markdown, used for read output and user-facing snippets.
- **Search context:** structured metadata plus markdown body, used where it improves search quality.

The distinction is intentional. Content is what the user wrote. Metadata is how the system understands where that content lives and why it may be relevant.

## Consequences

Reading chunks becomes more predictable. Users can trust that `read <chunk-id>` shows markdown from the vault rather than generated indexing context.

Search results become easier to understand. If a chunk ID is returned, it should point to content worth reading. Title-only matches can still appear, but as note-level results rather than misleading chunk-level results.

Snippets become more honest. They can focus on the body text that matched rather than synthetic metadata copied into every chunk.

Ranking can still benefit from metadata. Titles and headings remain important relevance signals, especially for short chunks, sparse notes, and sections whose body text relies on context. The system can include metadata in embedding input or structured keyword ranking without making that metadata part of the stored body.

The model better matches user expectations. Obsidian notes are authored as markdown. Returning markdown excerpts keeps Vaultgentic aligned with the source material and avoids surprising output that looks like an internal search document.

This decision does add some complexity. The system must be clear about which text is used for reading and which text is used for search. Tests need to cover both. Future contributors must avoid reintroducing generated metadata into stored chunk text for convenience.

Search behavior may shift. Some queries that previously matched chunks because the title or path was duplicated into every chunk may now return note-level title matches or different chunk rankings. This is acceptable because those previous chunk matches were often misleading.

Semantic search requires care. If embeddings use only raw body text, short chunks may lose important meaning. If embeddings include too much metadata, they may overemphasize titles or folder names. The recommended balance is controlled metadata context: include title and heading path when they clarify the body, avoid noisy metadata that does not describe the content, and keep generated embedding input separate from readable text.

Existing indexes may need to be rebuilt. Stored chunk text, hashes, snippets, and embeddings are part of the search index. Changing their meaning requires a rebuild path so old synthetic chunks do not remain in place.

Outline-only notes or empty sections may produce fewer or no chunks. That is a feature, not a regression. Notes can still be discoverable by title or metadata, but chunk IDs should remain reserved for readable content.

This ADR may lead to follow-up implementation decisions about exact ranking weights, snippet generation, and whether additional metadata fields need dedicated search support. Those should be treated as refinements of this decision, not reasons to keep metadata embedded in readable chunk text.
