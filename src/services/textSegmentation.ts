export const MAX_SEGMENT_CHARS = 240
const MIN_SEGMENT_CHARS = 4

const SENTENCE_DELIMITERS = /([。！？])/
const SUB_DELIMITERS = /([，、；])/

function splitKeepDelim(text: string, regex: RegExp): string[] {
  const parts = text.split(regex)
  const sentences: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? ''
    const delim = parts[i + 1] ?? ''
    const combined = body + delim
    if (combined) sentences.push(combined)
  }
  return sentences
}

function hardSplit(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += MAX_SEGMENT_CHARS) {
    out.push(text.slice(i, i + MAX_SEGMENT_CHARS))
  }
  return out
}

function splitOversizedSentence(sentence: string): string[] {
  if (sentence.length <= MAX_SEGMENT_CHARS) return [sentence]
  const subs = splitKeepDelim(sentence, SUB_DELIMITERS)
  if (subs.length <= 1) return hardSplit(sentence)

  const out: string[] = []
  let buf = ''
  for (const sub of subs) {
    if (sub.length > MAX_SEGMENT_CHARS) {
      if (buf) { out.push(buf); buf = '' }
      out.push(...hardSplit(sub))
      continue
    }
    if (buf.length + sub.length > MAX_SEGMENT_CHARS) {
      out.push(buf)
      buf = sub
    } else {
      buf += sub
    }
  }
  if (buf) out.push(buf)
  return out
}

export function textSegmentation(input: string): string[] {
  const text = input.trim()
  if (!text) return []

  const sentences = splitKeepDelim(text, SENTENCE_DELIMITERS)
  const effective = sentences.length > 0 ? sentences : [text]

  const segments: string[] = []
  let buf = ''

  for (const sentence of effective) {
    if (sentence.length > MAX_SEGMENT_CHARS) {
      if (buf) { segments.push(buf); buf = '' }
      segments.push(...splitOversizedSentence(sentence))
      continue
    }
    if (buf.length + sentence.length > MAX_SEGMENT_CHARS) {
      segments.push(buf)
      buf = sentence
    } else {
      buf += sentence
    }
  }
  if (buf) segments.push(buf)

  // Merge a tiny trailing fragment into the previous segment, only if it doesn't exceed the limit.
  if (segments.length >= 2) {
    const last = segments[segments.length - 1]
    const prev = segments[segments.length - 2]
    if (last.length < MIN_SEGMENT_CHARS && prev.length + last.length <= MAX_SEGMENT_CHARS) {
      segments.pop()
      segments[segments.length - 1] += last
    }
  }

  return segments
}
