/**
 * Fetches Twitch VOD chat replay via the public GQL API.
 */

const TWITCH_GQL_URL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c81f04a6f4077b48";

export interface ChatFragment {
  text: string;
  emote: { emoteID: string } | null;
}

export interface ChatMessage {
  offsetSeconds: number;
  fragments: ChatFragment[];
  text: string;
}

export function extractVideoId(url: string): string | null {
  const match = url.match(/twitch\.tv\/videos\/(\d+)/);
  return match ? match[1] : null;
}

async function fetchCommentPage(
  videoId: string,
  cursor?: string,
  offsetSeconds?: number
): Promise<{ messages: ChatMessage[]; nextCursor: string | null }> {
  const variables: Record<string, unknown> = { videoID: videoId };
  if (cursor) {
    variables.cursor = cursor;
  } else {
    variables.contentOffsetSeconds = offsetSeconds ?? 0;
  }

  const res = await fetch(TWITCH_GQL_URL, {
    method: "POST",
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      {
        operationName: "VideoCommentsByOffsetOrCursor",
        variables,
        extensions: {
          persistedQuery: { version: 1, sha256Hash: GQL_HASH },
        },
      },
    ]),
  });

  if (!res.ok) {
    throw new Error(`Twitch GQL API returned ${res.status}`);
  }

  const json = await res.json();
  const comments = json[0]?.data?.video?.comments;

  if (!comments || !comments.edges || comments.edges.length === 0) {
    return { messages: [], nextCursor: null };
  }

  const messages: ChatMessage[] = comments.edges.map((edge: any) => {
    const frags: ChatFragment[] = edge.node.message.fragments ?? [];
    return {
      offsetSeconds: edge.node.contentOffsetSeconds,
      fragments: frags,
      text: frags.map((f: ChatFragment) => f.text).join(""),
    };
  });

  const nextCursor = comments.pageInfo.hasNextPage
    ? comments.edges[comments.edges.length - 1]?.cursor
    : null;

  return { messages, nextCursor };
}

/**
 * Fetches a batch of chat messages starting from a given offset.
 * Returns the messages and a cursor for fetching the next batch.
 */
export async function fetchChatBatch(
  videoId: string,
  opts?: { startOffsetSeconds?: number; cursor?: string; maxPages?: number }
): Promise<{ messages: ChatMessage[]; nextCursor: string | null }> {
  const maxPages = opts?.maxPages ?? 3; // fetch a few pages per batch
  const allMessages: ChatMessage[] = [];
  let currentCursor: string | undefined = opts?.cursor ?? undefined;

  // First request: use offset or cursor
  const first = await fetchCommentPage(
    videoId,
    currentCursor,
    currentCursor ? undefined : (opts?.startOffsetSeconds ?? 0)
  );
  allMessages.push(...first.messages);
  currentCursor = first.nextCursor ?? undefined;

  let pagesProcessed = 1;

  // Fetch subsequent pages
  while (currentCursor && pagesProcessed < maxPages) {
    const page = await fetchCommentPage(videoId, currentCursor);
    if (page.messages.length === 0) break;
    allMessages.push(...page.messages);
    currentCursor = page.nextCursor ?? undefined;
    pagesProcessed++;
  }

  return { messages: allMessages, nextCursor: currentCursor ?? null };
}

/**
 * Iterates through ALL chat messages for a VOD, calling onBatch for each page.
 * Stops after maxPages or when there are no more messages.
 */
export async function iterateChat(
  videoId: string,
  onBatch: (messages: ChatMessage[]) => void,
  opts?: { maxPages?: number; startOffsetSeconds?: number }
): Promise<{ pagesProcessed: number; lastOffsetSeconds: number }> {
  const maxPages = opts?.maxPages ?? 10_000; // safety limit
  let cursor: string | undefined;
  let pagesProcessed = 0;
  let lastOffset = 0;

  // First request uses offset
  const first = await fetchCommentPage(
    videoId,
    undefined,
    opts?.startOffsetSeconds ?? 0
  );
  if (first.messages.length > 0) {
    onBatch(first.messages);
    lastOffset = first.messages[first.messages.length - 1].offsetSeconds;
  }
  pagesProcessed++;

  cursor = first.nextCursor ?? undefined;

  // Subsequent requests use cursor
  while (cursor && pagesProcessed < maxPages) {
    const page = await fetchCommentPage(videoId, cursor);
    if (page.messages.length === 0) break;

    onBatch(page.messages);
    lastOffset = page.messages[page.messages.length - 1].offsetSeconds;
    pagesProcessed++;

    cursor = page.nextCursor ?? undefined;
  }

  return { pagesProcessed, lastOffsetSeconds: lastOffset };
}
