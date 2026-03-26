// api/create-order.js
// Tạo đơn hàng mới — lưu vào Vercel KV, trả về mã QR động

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ họ tên và email.' });
  }

  // ── Tạo mã đơn hàng duy nhất ──────────────────────────────
  const suffix   = Math.random().toString(36).slice(2, 6).toUpperCase();
  const orderCode = `50P${suffix}`;                     // vd: 50PABCD
  const content   = `EBOOK50P ${orderCode}`;            // Nội dung chuyển khoản

  const order = {
    code:      orderCode,
    content,
    name,
    email,
    phone:     phone || '',
    amount:    149000,
    product:   '50 Prompt Tạo Ảnh AI Phong Cách',
    status:    'pending',                               // pending | paid
    invoiceNo: null,
    paidAt:    null,
    createdAt: new Date().toISOString(),
  };

  // Lưu KV — hết hạn sau 48 giờ
  await kv.set(`order:${orderCode}`, order, { ex: 172800 });

  // ── URL QR VietQR (ACB) ────────────────────────────────────
  const qrUrl = [
    `https://img.vietqr.io/image/ACB-${process.env.ACB_ACCOUNT}-compact2.png`,
    `?amount=149000`,
    `&addInfo=${encodeURIComponent(content)}`,
    `&accountName=${encodeURIComponent(process.env.ACCOUNT_NAME)}`,
  ].join('');

  return res.status(200).json({
    success:  true,
    orderCode,
    content,
    qrUrl,
    bankInfo: {
      bank:    'ACB',
      account: process.env.ACB_ACCOUNT,
      name:    process.env.ACCOUNT_NAME,
      amount:  149000,
      content,
    },
  });
}
