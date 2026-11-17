interface HermesHealth {
  status?: unknown;
  version?: unknown;
}

async function readBoundedHealth(response: Response, maxBytes: number): Promise<HermesHealth | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(new TextDecoder().decode(buffer.subarray(0, size)));
      if (size + value.byteLength > maxBytes) return null;
      buffer.set(value, size);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function readHermesHealth(url: string, timeoutMs = 2500, maxBytes?: number): Promise<HermesHealth | null> {
  try {
    const response = await fetch(`${url}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return maxBytes === undefined ? await response.json() : await readBoundedHealth(response, maxBytes);
  } catch {
    return null;
  }
}
