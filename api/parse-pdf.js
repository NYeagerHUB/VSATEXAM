/**
 * Vercel Serverless Function: /api/parse-pdf
 * Proxy request từ browser → Anthropic API
 *
 * SETUP:
 *   1. Tạo folder "api" trong root project Vercel
 *   2. Đặt file này vào api/parse-pdf.js
 *   3. Vào Vercel Dashboard → Settings → Environment Variables
 *      Thêm: ANTHROPIC_API_KEY = sk-ant-...
 */

export default async function handler(req, res) {
  // CORS headers — cho phép browser gọi
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY chưa được cấu hình trong Vercel Environment Variables' });
  }

  try {
    const { base64, filename } = req.body;
    if (!base64) {
      return res.status(400).json({ error: 'Thiếu dữ liệu PDF (base64)' });
    }

    const systemPrompt = `Bạn là hệ thống phân tích đề thi VSAT của Đại học Cần Thơ. Hãy đọc file PDF đề thi và trích xuất TẤT CẢ câu hỏi.

ĐỊNH DẠNG OUTPUT: Chỉ trả về JSON array thuần túy, không có markdown, không có backtick, không có giải thích.

CẤU TRÚC MỖI CÂU:
- Câu Đúng/Sai (câu 01-09): {"id":"auto","type":"truefalse","question":"Nội dung dẫn câu","statements":["mệnh đề 1","mệnh đề 2","mệnh đề 3","mệnh đề 4"],"answers":["D","S","D","S"]}
- Câu MCQ (câu 10-15): {"id":"auto","type":"mcq","question":"Nội dung câu hỏi","options":["A. ...","B. ...","C. ...","D. ..."],"answer":0}
  (answer là index 0-3 tương ứng A-D)
- Câu ghép cột (câu 16-20): {"id":"auto","type":"matching","question":"Nội dung","left":["ý 1","ý 2","ý 3","ý 4"],"right":["A. ...","B. ...","C. ...","D. ...","E. ...","F. ..."],"answers":[indexA,indexB,indexC,indexD]}
  (answers là array index 0-based của cột phải tương ứng với từng ý cột trái)
- Câu trả lời ngắn (câu 21-25): {"id":"auto","type":"short","question":"Nội dung câu hỏi","answer":"đáp án"}

QUY TẮC:
- Nếu câu có hình ảnh/sơ đồ không đọc được, ghi "[IMG:PLACEHOLDER]" vào question
- Giữ nguyên ký hiệu hóa học: H₂SO₄, Fe²⁺, NH₃ (dùng unicode)
- Giữ nguyên công thức toán bằng LaTeX: \\(x^2\\)
- answers cho truefalse: "D" = Đúng, "S" = Sai, null nếu không rõ
- Trích xuất ĐẦY ĐỦ tất cả 25 câu
- KHÔNG thêm bất kỳ trường nào khác ngoài schema trên`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            {
              type: 'text',
              text: 'Hãy trích xuất tất cả câu hỏi từ đề thi này. Trả về JSON array thuần túy.'
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || `Anthropic API error ${response.status}` });
    }

    const data = await response.json();
    const raw = data.content.map(c => c.text || '').join('');

    // Parse JSON — bỏ markdown nếu có
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let questions;
    try {
      questions = JSON.parse(clean);
    } catch {
      const m = clean.match(/\[[\s\S]*\]/);
      if (m) questions = JSON.parse(m[0]);
      else return res.status(500).json({ error: 'AI không trả về JSON hợp lệ', raw: clean.slice(0, 500) });
    }

    return res.status(200).json({ questions });

  } catch (err) {
    console.error('parse-pdf error:', err);
    return res.status(500).json({ error: err.message });
  }
}
