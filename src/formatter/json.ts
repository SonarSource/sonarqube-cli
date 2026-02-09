// JSON formatter

export function formatJSON(data: any, pretty: boolean = true): string {
  if (pretty) {
    return JSON.stringify(data, null, 2);
  }
  return JSON.stringify(data);
}
