/** Decode the bounded MCP receipt formats that Hermes uses on its run and session APIs. */
export function readMcpResult(output: unknown): Record<string, unknown> | null {
  if (typeof output === 'string' && output.length > 500) return null;
  try {
    let value = typeof output === 'string' ? JSON.parse(output) : output;
    if (typeof value?.result === 'string') value = JSON.parse(value.result);
    const items = Array.isArray(value) ? value : value?.content;
    if (items !== undefined) {
      if (!Array.isArray(items) || items.length !== 1 || items[0]?.type !== 'text' ||
          typeof items[0].text !== 'string' || value?.isError === true) return null;
      value = JSON.parse(items[0].text);
    }
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
