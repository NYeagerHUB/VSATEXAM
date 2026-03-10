/**
 * /api/gemini.js — Vercel Serverless Function
 * Gemini AI Chat cho VSAT exam system
 * ENV: GEMINI_API_KEY
 */

const GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-2.0-flash-lite',
];

async function geminiCall(apiKey, body) {
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status === 503) {
          const errData = await res.json().catch(() => ({}));
          const match = JSON.stringify(errData).match(/retry in ([\d.]+)s/i);
          const wait = match ? Math.min(parseFloat(match[1]) * 1000, 8000) : (attempt + 1) * 2000;
          await new Promise(r => setTimeout(r, wait));
          lastErr = errData;
          continue;
        }
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const msg = errData?.error?.message || `HTTP ${res.status}`;
          if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) { lastErr = msg; break; }
          throw new Error(msg);
        }
        return await res.json();
      } catch (err) {
        lastErr = err.message;
        if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
      }
    }
  }
  throw new Error(`Gemini lỗi: ${lastErr}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY chưa cấu hình' });

  try {
    const { history = [] } = req.body;
    if (!history.length) return res.status(400).json({ error: 'Thiếu history' });

    const systemInstruction = `Bạn là trợ lý AI hỗ trợ học sinh ôn thi V-SAT (kỳ thi đánh giá năng lực Đại học Cần Thơ). 
Bạn giỏi về: Toán, Vật Lý, Hóa Học, Sinh Học, Ngữ Văn, Lịch Sử, Địa Lý, Tiếng Anh.
Trả lời bằng tiếng Việt, ngắn gọn, dễ hiểu.
Dùng LaTeX cho công thức toán: $x^2 + 1 = 0$ (inline), $$\\int_0^1 x dx$$ (block).
Khi giải thích đáp án, nêu rõ đáp án đúng là gì và tại sao.`;

    const data = await geminiCall(apiKey, {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: history,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      }
    });

    const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!reply) throw new Error('Gemini không trả về nội dung');

    return res.status(200).json({ reply });
  } catch (err) {
    console.error('[gemini.js]', err);
    return res.status(500).json({ error: err.message });
  }
}
