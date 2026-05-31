// & 必须最先替换，否则会二次转义 &lt; 里的 &
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function buildSSML(text: string): string {
  return `<speak>${escapeXml(text)}</speak>`
}
