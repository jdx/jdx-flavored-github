type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchNotificationPageResponse(
  url: string,
  fetch_: Fetch = fetch,
): Promise<Response | undefined> {
  try {
    return await fetch_(url, {credentials: 'same-origin'});
  } catch {
    return undefined;
  }
}
