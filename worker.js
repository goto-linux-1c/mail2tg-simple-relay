export default {
  async email(message, env, ctx) {
    const fromHeader = message.from;
    const senderEmail = extractEmail(fromHeader);

    // --- ФИЛЬТР ОТПРАВИТЕЛЕЙ ---
    const allowedRaw = env.ALLOWED_SENDERS?.trim() || '';
    // Если '*' или пусто — пропускаем всех
    // Иначе фильтруем по списку
    if (allowedRaw !== '' && allowedRaw !== '*') {
      const allowedList = allowedRaw.split(',').map(s => s.trim().toLowerCase());
      if (!allowedList.includes(senderEmail.toLowerCase())) {
        return; // отправитель не в списке, ничего не делаем
      }
    }

    // --- ЧТЕНИЕ И ПАРСИНГ ПИСЬМА ---
    let rawText;
    try {
      const raw = message.raw;
      let buffer;
      if (raw instanceof ArrayBuffer) {
        buffer = raw;
      } else if (raw instanceof Uint8Array) {
        buffer = raw.buffer;
      } else if (typeof raw.arrayBuffer === 'function') {
        buffer = await raw.arrayBuffer();
      } else {
        const response = new Response(raw);
        buffer = await response.arrayBuffer();
      }
      rawText = new TextDecoder('utf-8').decode(buffer);
    } catch {
      await sendToTelegram(env, 'Ошибка чтения письма', null);
      return;
    }

    const bodyText = extractBodyFromRaw(rawText);
    const cleaned = cleanAndTruncate(bodyText, 250);
    const important = isHighPriority(message.headers) ? '❗ ' : '';

    // --- ФОРМИРОВАНИЕ СООБЩЕНИЯ ---
    const senderLine = `<b>${htmlEscape(senderEmail)}</b>`;
    const finalText = `${important}${senderLine}\n${cleaned || '(пустое тело)'}`;

    // --- ОТПРАВКА В TELEGRAM (parse_mode=HTML) ---
    await sendToTelegram(env, finalText, 'HTML');
  },
};

// -------------------------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ --------------------------

async function sendToTelegram(env, text, parseMode = null) {
  const body = {
    chat_id: env.TELEGRAM_ID,
    text: text,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function extractEmail(from) {
  if (!from) return '';
  const match = from.match(/<([^>]+)>/);
  return match ? match[1].trim() : from.trim();
}

function htmlEscape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isHighPriority(headers) {
  const val = (headers.get('x-priority') || headers.get('importance') || headers.get('priority') || '').toLowerCase();
  return val === 'high' || val === '1' || val === '2';
}

// --- ПАРСИНГ ПИСЬМА (из последнего рабочего варианта) ---

function extractBodyFromRaw(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n') >= 0
    ? raw.indexOf('\r\n\r\n') + 4
    : raw.indexOf('\n\n') + 2;
  if (headerEnd <= 0) return '';

  const headers = raw.slice(0, headerEnd);
  const bodyRaw = raw.slice(headerEnd);

  const contentType = headers.match(/^content-type:\s*([^\r\n;]+)/im)?.[1]?.toLowerCase();
  const charsetMatch = headers.match(/charset="?([^"\r\n;]+)"?/im);
  const charset = charsetMatch ? charsetMatch[1] : null;

  if (contentType?.startsWith('multipart/')) {
    const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/im);
    if (!boundaryMatch) return '';
    const boundary = boundaryMatch[1];
    const parts = splitMimeByBoundary(bodyRaw, boundary);
    return extractFromParts(parts);
  } else {
    const encoding = headers.match(/^content-transfer-encoding:\s*([^\r\n;]+)/im)?.[1]?.toLowerCase();
    const decoded = decodeBody(bodyRaw.trim(), encoding, charset);
    if (contentType?.includes('html')) {
      return stripHtml(decoded);
    }
    return decoded;
  }
}

function extractFromParts(parts) {
  for (const part of parts) {
    const partInfo = parsePart(part);
    if (partInfo.type === 'text/plain') return partInfo.body;
  }
  for (const part of parts) {
    const partInfo = parsePart(part);
    if (partInfo.type === 'text/html') return stripHtml(partInfo.body);
  }
  for (const part of parts) {
    const partInfo = parsePart(part);
    if (partInfo.type?.startsWith('multipart/')) {
      const inner = extractBodyFromRaw(part);
      if (inner) return inner;
    }
  }
  return '';
}

function parsePart(partText) {
  const headerEnd = partText.indexOf('\r\n\r\n') >= 0
    ? partText.indexOf('\r\n\r\n') + 4
    : partText.indexOf('\n\n') + 2;
  if (headerEnd <= 0) return { type: '', body: '' };

  const headers = partText.slice(0, headerEnd).toLowerCase();
  const bodyRaw = partText.slice(headerEnd).trim();

  const contentType = headers.match(/content-type:\s*([^\r\n;]+)/)?.[1]?.trim();
  const charsetMatch = headers.match(/charset="?([^"\r\n;]+)"?/i);
  const charset = charsetMatch ? charsetMatch[1] : null;
  const encoding = headers.match(/content-transfer-encoding:\s*([^\r\n;]+)/)?.[1]?.trim();

  let body;
  if (contentType?.startsWith('multipart/')) {
    body = bodyRaw; // для рекурсии
  } else {
    body = decodeBody(bodyRaw, encoding, charset);
  }
  return { type: contentType, body };
}

function decodeBody(body, encoding, charset) {
  if (!encoding) return body;

  let bytes;
  switch (encoding.toLowerCase()) {
    case 'base64':
      try {
        const cleaned = body.replace(/\s/g, '');
        const binary = atob(cleaned);
        bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      } catch {
        return body;
      }
      break;
    case 'quoted-printable':
      bytes = decodeQuotedPrintableToBytes(body);
      break;
    default:
      return body; // 7bit, 8bit
  }
  return bytesToString(bytes, charset);
}

function bytesToString(bytes, charset) {
  if (!charset) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        return new TextDecoder('windows-1251', { fatal: true }).decode(bytes);
      } catch {
        return new TextDecoder('latin1').decode(bytes);
      }
    }
  }
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function decodeQuotedPrintableToBytes(str) {
  str = str.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '=' && i + 2 < str.length) {
      bytes.push(parseInt(str.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(str.charCodeAt(i));
    }
  }
  return new Uint8Array(bytes);
}

function splitMimeByBoundary(body, boundary) {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = body.split(new RegExp(`--${escaped}(?:--)?\\s*`));
  return parts.slice(1, parts.length - 1);
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gi, '')
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .trim();
}

function cleanAndTruncate(text, maxLen) {
  let cleaned = text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu, (c) => {
    const code = c.charCodeAt(0);
    return (code === 10 || code === 13 || code === 9) ? c : '';
  });
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxLen);
}
