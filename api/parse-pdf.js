/**
 * Vercel Serverless Function: /api/parse-pdf
 * Dùng Google Gemini API (free) để parse đề thi PDF
 *
 * SETUP:
 *   Vercel Dashboard → Settings → Environment Variables
 *   Thêm: GEMINI_API_KEY = AIza...
 *   Lấy key tại: https://aistudio.google.com/apikey
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY chưa được cấu hình. Vào Vercel → Settings → Environment Variables để thêm.'
    });
  }

  try {
    const { base64, filename } = req.body;
    if (!base64) return res.status(400).json({ error: 'Thiếu dữ liệu PDF' });

    const prompt = `Bạn là hệ thống trích xuất câu hỏi từ đề thi đại học Việt Nam. Đọc kỹ toàn bộ PDF và trích xuất TẤT CẢ câu hỏi.

CẤU TRÚC ĐỀ VSAT PHỔ BIẾN (nhưng hãy nhận diện linh hoạt với mọi loại đề):
- Câu 01–09: Đúng/Sai — có bảng "Phát biểu | Đúng | Sai" với 4 mệnh đề
- Câu 10–15: Trắc nghiệm — có 4 phương án A/B/C/D
- Câu 16–20: Ghép cột — cột trái 4 ý, cột phải 6 lựa chọn A–F
- Câu 21–25: Trả lời ngắn — điền số hoặc từ

NHẬN DIỆN LINH HOẠT:
- Bảng "T/F" trong đề Tiếng Anh → type: truefalse (T=D, F=S)
- "Read and choose A/B/C/D" → type: mcq
- "Match 1-4 with A-F" → type: matching
- "Fill in ONE word" → type: short
- Câu có đoạn văn dài → gộp hết đoạn văn vào question

OUTPUT: Chỉ JSON array. Không markdown, không backtick, không giải thích.

SCHEMA:
Đúng/Sai: {"id":"auto","type":"truefalse","question":"dẫn đề","statements":["m1","m2","m3","m4"],"answers":["D","S","D","S"]}
MCQ: {"id":"auto","type":"mcq","question":"câu hỏi","options":["A. ...","B. ...","C. ...","D. ..."],"answer":1}
Ghép cột: {"id":"auto","type":"matching","question":"câu hỏi","left":["ý1","ý2","ý3","ý4"],"right":["A....","B....","C....","D....","E....","F...."],"answers":[0,2,1,3]}
Trả lời ngắn: {"id":"auto","type":"short","question":"câu hỏi đầy đủ","answer":"đáp án","placeholder":"gợi ý"}

QUY TẮC:
- Giữ công thức: H₂SO₄ Fe²⁺ hoặc LaTeX \\(\\frac{a}{b}\\)
- Câu có hình/đồ thị → thêm "[IMG:PLACEHOLDER]" vào question
- answer/answers = null nếu đề không có đáp án
- KHÔNG bỏ sót câu nào
- Đề Tiếng Anh Part 1: question = nội dung biển/tin nhắn/quảng cáo, statements = 4 nhận định T/F`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: base64 } },
              { text: prompt }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      return res.status(geminiRes.status).json({ error: err.error?.message || `Gemini error ${geminiRes.status}` });
    }

    const geminiData = await geminiRes.json();
    const raw = (geminiData.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('');

    if (!raw) return res.status(500).json({ error: 'Gemini không trả về kết quả. Thử lại.' });

    let questions;
    try {
      const clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      questions = JSON.parse(clean);
    } catch {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) { try { questions = JSON.parse(m[0]); } catch { return res.status(500).json({ error: 'Không parse được JSON', raw: raw.slice(0,300) }); } }
      else return res.status(500).json({ error: 'AI không trả về JSON hợp lệ', raw: raw.slice(0,300) });
    }

    if (!Array.isArray(questions)) {
      if (questions?.questions) questions = questions.questions;
      else return res.status(500).json({ error: 'Kết quả không phải array', raw: raw.slice(0,300) });
    }

    if (!questions.length) return res.status(500).json({ error: 'Không tìm thấy câu hỏi nào' });

    return res.status(200).json({ questions, total: questions.length });

  } catch(err) {
    console.error('parse-pdf error:', err);
    return res.status(500).json({ error: err.message });
  }
}
