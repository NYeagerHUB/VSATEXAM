/**
 * /api/parse-pdf.js  —  Vercel Serverless Function
 * Kiến trúc 2 bước (inspired by Azota formatExam.ts):
 *   Bước 1: Gemini OCR → raw text có cấu trúc
 *   Bước 2: Regex parser → JSON câu hỏi VSAT
 *
 * ENV: GEMINI_API_KEY (Vercel → Settings → Environment Variables)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY chưa cấu hình trong Vercel Environment Variables' });

  try {
    const { base64, filename } = req.body;
    if (!base64) return res.status(400).json({ error: 'Thiếu dữ liệu PDF (base64)' });

    // ═══════════════════════════════════════════════════════
    // BƯỚC 1: Gemini OCR — chỉ trích xuất text, không cấu trúc
    // ═══════════════════════════════════════════════════════
    const ocrPrompt = `Đây là một đề thi Việt Nam dạng PDF. Hãy chép lại TOÀN BỘ nội dung text của đề thi này, giữ nguyên cấu trúc như trong PDF.

YÊU CẦU QUAN TRỌNG:
1. Giữ nguyên xuống hàng — mỗi dòng trong PDF là một dòng trong output
2. Giữ nguyên ký hiệu: H₂SO₄, Fe²⁺, x², → (dùng unicode), hoặc LaTeX $...$
3. Giữ nguyên "Phần I.", "Câu 1.", "A.", "B.", "C.", "D." chính xác
4. Giữ nguyên bảng Đúng/Sai: "a)", "b)", "c)", "d)" với cột Đúng | Sai
5. Giữ nguyên cột ghép: "(1)", "(2)" hoặc số thứ tự bên trái, và "A.", "B." bên phải
6. Nếu có hình/đồ thị không đọc được, ghi: [HÌNH: mô tả ngắn]
7. KHÔNG thêm bất kỳ giải thích hay phân tích nào
8. KHÔNG bỏ sót câu hỏi nào
9. Với phương trình nhiều dòng: gộp về 1 dòng liền mạch

Chép nguyên văn:`;

    const ocrRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: base64 } },
              { text: ocrPrompt }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192 }
        })
      }
    );

    if (!ocrRes.ok) {
      const err = await ocrRes.json();
      return res.status(ocrRes.status).json({ error: `Gemini OCR error: ${err.error?.message || ocrRes.status}` });
    }

    const ocrData = await ocrRes.json();
    const rawText = (ocrData.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');

    if (!rawText?.trim()) return res.status(500).json({ error: 'Gemini không trả về text. Thử lại.' });

    // ═══════════════════════════════════════════════════════
    // BƯỚC 2: Regex Parser (Azota-inspired) → JSON
    // ═══════════════════════════════════════════════════════
    const questions = parseVSATText(rawText);

    if (!questions.length) {
      // Fallback: nếu regex parse không ra câu nào, dùng Gemini để parse JSON
      return await fallbackGeminiParse(rawText, apiKey, res);
    }

    return res.status(200).json({ questions, total: questions.length, rawText });

  } catch (err) {
    console.error('parse-pdf error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
// REGEX PARSER — Phân tích text theo format đề thi VSAT
// Inspired by Azota's formatExam.ts (splitTextByDelimiter pattern)
// ═══════════════════════════════════════════════════════════

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function splitTextByDelimiter(text, regex) {
  const matches = Array.from(text.matchAll(regex));
  if (!matches.length) return [[], [text]];
  const positions = matches.map(m => m.index);
  positions.push(text.length);
  const parts = [];
  for (let i = 0; i < positions.length - 1; i++) {
    parts.push(text.slice(positions[i], positions[i + 1]).trim());
  }
  return [matches, parts];
}

function parseVSATText(rawText) {
  const questions = [];
  const lines = rawText.split('\n');

  // Phát hiện loại đề: VSAT chuẩn, đề thường, hay Tiếng Anh
  const hasParts = /Phần\s+(I{1,3}|[IVX]+|\d+)[.\s]/i.test(rawText);
  const hasEnglishTF = /True\s*\/\s*False|T\s*F\s*$/im.test(rawText);

  if (hasParts) {
    // Đề có cấu trúc Phần I, II, III... (VSAT chuẩn)
    parseVSATStandard(rawText, lines, questions);
  } else {
    // Đề không có Phần → parse trực tiếp câu hỏi
    parseQuestionsDirect(rawText, lines, questions);
  }

  return questions;
}

function parseVSATStandard(rawText, lines, questions) {
  // Tách thành các Phần
  const partRegex = /Phần\s+(I{1,3}|[IVX]+|\d+)[.\s]/gi;
  const [partMatches, parts] = splitTextByDelimiter(rawText, partRegex);

  parts.forEach((partText, idx) => {
    const partHeader = partMatches[idx]?.[0]?.toLowerCase() || '';

    // Xác định loại câu trong phần này
    let expectedType = 'mcq'; // mặc định
    if (/phần.*i[^iv]/i.test(partHeader) || partText.includes('Đúng') && partText.includes('Sai')) {
      expectedType = 'truefalse';
    } else if (/phần.*ii[^i]/i.test(partHeader) || /A\.\s|B\.\s|C\.\s|D\.\s/.test(partText)) {
      expectedType = 'mcq';
    } else if (/phần.*iii/i.test(partHeader) || partText.includes('ghép') || partText.includes('nối')) {
      expectedType = 'matching';
    } else if (/phần.*iv/i.test(partHeader) || /trả lời ngắn|điền/i.test(partText)) {
      expectedType = 'short';
    }

    // Phát hiện thông minh hơn dựa vào nội dung
    if (partText.match(/\ba\)\s|\bb\)\s|\bc\)\s|\bd\)\s/)) expectedType = 'truefalse';
    if (partText.match(/^\s*\(\d+\)/m) && partText.match(/^\s*[A-F]\./m)) expectedType = 'matching';

    parseQuestionsInPart(partText, lines, questions, expectedType);
  });
}

function parseQuestionsInPart(partText, lines, questions, expectedType) {
  // Regex nhận diện câu hỏi: "Câu 1." hoặc "Câu 01." hoặc "Question 1."
  const questionRegex = /(?:Câu|Question|Q)\s*(\d+)[.:\s]/gi;
  const [qMatches, qParts] = splitTextByDelimiter(partText, questionRegex);

  qParts.forEach((qText, idx) => {
    if (!qText.trim() || qText.length < 5) return;

    const qNum = qMatches[idx]?.[1] || String(idx + 1);

    // Auto-detect type từ nội dung câu
    const type = detectQuestionType(qText, expectedType);
    const q = parseQuestionByType(qText, type, qNum);
    if (q) questions.push(q);
  });
}

function parseQuestionsDirect(rawText, lines, questions) {
  const questionRegex = /(?:Câu|Question|Q)\s*(\d+)[.:\s]/gi;
  const [qMatches, qParts] = splitTextByDelimiter(rawText, questionRegex);

  qParts.forEach((qText, idx) => {
    if (!qText.trim() || qText.length < 5) return;
    const qNum = qMatches[idx]?.[1] || String(idx + 1);
    const type = detectQuestionType(qText, 'mcq');
    const q = parseQuestionByType(qText, type, qNum);
    if (q) questions.push(q);
  });
}

function detectQuestionType(text, defaultType) {
  // Dấu hiệu truefalse: bảng a) b) c) d), hoặc cột Đúng/Sai
  if (/\ba\)\s|\bb\)\s|\bc\)\s|\bd\)\s/.test(text)) return 'truefalse';
  if (/Đúng.*Sai|True.*False|T\s*F\s/i.test(text)) return 'truefalse';

  // Dấu hiệu matching: cột trái đánh số, cột phải đánh chữ A-F
  if (/\(\d+\).*[A-F]\.|^\s*[1-4][.)]/m.test(text) &&
      /[A-F]\.\s+\w/.test(text) && !/^\s*[A-D]\./m.test(text)) return 'matching';

  // Dấu hiệu MCQ: có A. B. C. D.
  if (/^\s*[A-D]\.\s/m.test(text)) return 'mcq';

  // Dấu hiệu short: không có options, yêu cầu điền số
  if (/điền|tính|bằng\s+bao\s+nhiêu|là\s+bao\s+nhiêu|fill/i.test(text)) return 'short';

  return defaultType;
}

function parseQuestionByType(text, type, qNum) {
  switch (type) {
    case 'mcq':      return parseMCQ(text, qNum);
    case 'truefalse': return parseTrueFalse(text, qNum);
    case 'matching': return parseMatching(text, qNum);
    case 'short':    return parseShort(text, qNum);
    default:         return parseMCQ(text, qNum);
  }
}

// ─── MCQ Parser ──────────────────────────────────────────────────────────────
function parseMCQ(text, qNum) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Tách options A. B. C. D.
  const optionRegex = /^\*?([A-D])\.\s+(.*)/;
  const optionLines = [];
  const questionLines = [];
  let correctIdx = null;

  lines.forEach(line => {
    const m = line.match(optionRegex);
    if (m) {
      const isCorrect = line.startsWith('*');
      if (isCorrect) correctIdx = 'ABCD'.indexOf(m[1]);
      optionLines.push({ key: m[1], content: m[2].trim(), isCorrect });
    } else if (!optionLines.length) {
      questionLines.push(line);
    }
  });

  if (!optionLines.length) return parseShort(text, qNum); // không có options → short

  // Bỏ "Câu X." ở đầu question
  const rawQ = questionLines.join(' ').replace(/^(?:Câu|Question|Q)\s*\d+[.:\s]+/i, '').trim();

  return {
    id: uid(),
    type: 'mcq',
    question: rawQ || `Câu ${qNum}`,
    options: optionLines.map(o => `${o.key}. ${o.content}`),
    answer: correctIdx !== null ? String(correctIdx) : null,
  };
}

// ─── True/False Parser ───────────────────────────────────────────────────────
function parseTrueFalse(text, qNum) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Regex nhận diện mệnh đề: "a)", "b)", "c)", "d)" hoặc "a.", "b."
  const stmtRegex = /^[a-d][.)]\s+(.*)/i;
  // Nhận diện đáp án: dòng có "Đúng" hoặc "Sai" sau mệnh đề
  const answerRegex = /\b(Đúng|Sai|True|False|T|F)\b/i;

  const statements = [];
  const answers = [];
  const questionLines = [];
  let inStatements = false;

  lines.forEach(line => {
    const sm = line.match(stmtRegex);
    if (sm) {
      inStatements = true;
      let content = sm[1];
      // Tách đáp án nếu có trong cùng dòng: "a) Nội dung ... Đúng"
      const am = content.match(/\s+(Đúng|Sai|True|False)\s*$/i);
      let ans = null;
      if (am) {
        const v = am[1].toLowerCase();
        ans = (v === 'đúng' || v === 'true') ? 'D' : 'S';
        content = content.slice(0, am.index).trim();
      }
      statements.push(content);
      answers.push(ans);
    } else if (!inStatements) {
      questionLines.push(line);
    } else {
      // Dòng chỉ có Đúng/Sai (bảng tách biệt)
      const am = line.match(/^(Đúng|Sai|True|False|T|F)\s*$/i);
      if (am && statements.length > answers.filter(Boolean).length) {
        const v = am[1].toLowerCase();
        const idx = answers.findLastIndex(a => a === null);
        if (idx !== -1) answers[idx] = (v === 'đúng' || v === 'true') ? 'D' : 'S';
      }
    }
  });

  if (!statements.length) return parseShort(text, qNum);

  const rawQ = questionLines.join(' ').replace(/^(?:Câu|Question|Q)\s*\d+[.:\s]+/i, '').trim();

  // Đảm bảo 4 phần tử
  while (statements.length < 4) { statements.push(''); answers.push(null); }
  while (answers.length < statements.length) answers.push(null);

  return {
    id: uid(),
    type: 'truefalse',
    question: rawQ || `Câu ${qNum}`,
    statements: statements.slice(0, 4),
    answers: answers.slice(0, 4),
  };
}

// ─── Matching Parser ─────────────────────────────────────────────────────────
function parseMatching(text, qNum) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const leftRegex  = /^(?:\((\d+)\)|(\d+)[.)]\s)(.+)/;   // (1) hoặc 1. hoặc 1)
  const rightRegex = /^([A-F])\.\s+(.*)/;

  const left = [], right = [], answers = [];
  const questionLines = [];

  lines.forEach(line => {
    const lm = line.match(leftRegex);
    const rm = line.match(rightRegex);
    if (lm) {
      left.push(lm[3].trim());
    } else if (rm) {
      right.push(`${rm[1]}. ${rm[2].trim()}`);
    } else if (!left.length) {
      questionLines.push(line);
    }
  });

  if (!left.length || !right.length) return parseShort(text, qNum);

  // answers: null (chưa biết đáp án từ text)
  for (let i = 0; i < left.length; i++) answers.push(null);

  const rawQ = questionLines.join(' ').replace(/^(?:Câu|Question|Q)\s*\d+[.:\s]+/i, '').trim();

  return {
    id: uid(),
    type: 'matching',
    question: rawQ || `Câu ${qNum}`,
    left: left.slice(0, 6),
    right: right.slice(0, 8),
    answers,
  };
}

// ─── Short Answer Parser ─────────────────────────────────────────────────────
function parseShort(text, qNum) {
  const clean = text
    .replace(/^(?:Câu|Question|Q)\s*\d+[.:\s]+/i, '')
    .replace(/\[HÌNH:[^\]]*\]/g, '[IMG:PLACEHOLDER]')
    .trim();

  // Tìm đáp án nếu có: "Đáp án: X" hoặc "Kết quả: X"
  const answerMatch = clean.match(/(?:Đáp án|Answer|Kết quả|Result)\s*[:\s]\s*(.+?)(?:\n|$)/i);

  return {
    id: uid(),
    type: 'short',
    question: clean.replace(/(?:Đáp án|Answer)[^]*$/, '').trim() || `Câu ${qNum}`,
    answer: answerMatch ? answerMatch[1].trim() : null,
    placeholder: 'Nhập đáp án',
  };
}

// ═══════════════════════════════════════════════════════════
// FALLBACK: Nếu regex parse không ra câu nào
// Gọi lại Gemini lần 2 với raw text đã có, yêu cầu trả JSON
// ═══════════════════════════════════════════════════════════
async function fallbackGeminiParse(rawText, apiKey, res) {
  const prompt = `Đây là nội dung text từ một đề thi Việt Nam đã được OCR.
Hãy phân tích và trả về JSON array các câu hỏi.

OUTPUT: Chỉ JSON array thuần túy. Không markdown, không giải thích.

SCHEMA:
- Đúng/Sai: {"id":"auto","type":"truefalse","question":"...","statements":["a)...","b)...","c)...","d)..."],"answers":["D","S","D","S"]}
- MCQ: {"id":"auto","type":"mcq","question":"...","options":["A....","B....","C....","D...."],"answer":"0"}
- Ghép cột: {"id":"auto","type":"matching","question":"...","left":["(1)...","(2)..."],"right":["A....","B....","C...."],"answers":[null,null]}
- Trả lời ngắn: {"id":"auto","type":"short","question":"...","answer":null}

answers cho truefalse: "D"=Đúng, "S"=Sai, null nếu không có
answer MCQ: "0","1","2","3" (index A-D), null nếu không có

TEXT ĐỀ THI:
${rawText.slice(0, 12000)}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    if (!r.ok) throw new Error(`Gemini fallback error ${r.status}`);
    const data = await r.json();
    const raw = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');

    let questions;
    try { questions = JSON.parse(raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()); }
    catch { const m = raw.match(/\[[\s\S]*\]/); questions = m ? JSON.parse(m[0]) : []; }

    if (!Array.isArray(questions)) questions = questions?.questions || [];
    questions.forEach(q => { if (!q.id || q.id === 'auto') q.id = uid(); });

    return res.status(200).json({ questions, total: questions.length, rawText, usedFallback: true });

  } catch (err) {
    return res.status(500).json({ error: 'Không parse được câu hỏi: ' + err.message, rawText });
  }
}
