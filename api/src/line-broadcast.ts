export type LineBroadcastDraft = {
  title: string
  messageType: 'text' | 'flex'
  messageContent: string
  altText?: string
}

const FLEX_TEXT_CHUNK_SIZE = 1500

function firstHttpsUrl(message: string): string | null {
  const match = message.match(/https:\/\/[^\s<>"']+/i)
  return match ? match[0].replace(/[)\]}>、。,.!?！？]+$/, '') : null
}

function splitFlexText(message: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < message.length; offset += FLEX_TEXT_CHUNK_SIZE) {
    chunks.push(message.slice(offset, offset + FLEX_TEXT_CHUNK_SIZE))
  }
  return chunks.length > 0 ? chunks : ['']
}

export function buildLineBroadcastDraft(title: string, message: string, imageUrl?: string | null): LineBroadcastDraft {
  if (!imageUrl) return { title, messageType: 'text', messageContent: message }

  const primaryUrl = firstHttpsUrl(message)
  const bodyContents: Array<Record<string, unknown>> = splitFlexText(message).map(text => ({
    type: 'text',
    text,
    wrap: true,
    size: 'md',
    color: '#1F2937',
    lineSpacing: '5px',
  }))
  const contents: Record<string, unknown> = {
    type: 'bubble',
    hero: {
      type: 'image',
      url: imageUrl,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover',
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: bodyContents,
    },
  }
  if (primaryUrl) {
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#234E5C',
        action: { type: 'uri', label: '詳しく見る', uri: primaryUrl },
      }],
    }
  }

  return {
    title,
    messageType: 'flex',
    // Harness v0.15のauto-trackはFlex JSON内の画像URLまで追跡URLに変換する。
    // JSONとして等価な `\/` 表現にして抽出だけを回避し、LINEへは元URLを渡す。
    messageContent: JSON.stringify(contents).replace(imageUrl, imageUrl.replace(/\//g, '\\/')),
    altText: message.replace(/\s+/g, ' ').trim().slice(0, 400) || title.slice(0, 400),
  }
}
