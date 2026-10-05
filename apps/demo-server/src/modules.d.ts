/** Wrangler bundles these as `Data` and `Text` modules (`rules` in wrangler.jsonc). */
declare module '*.jpg' {
  const data: ArrayBuffer;
  export default data;
}

declare module '*.ndjson' {
  const text: string;
  export default text;
}
