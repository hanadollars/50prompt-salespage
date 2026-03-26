// api/check-payment.js
// Frontend gọi mỗi 3 giây để kiểm tra trạng thái đơn hàng

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing order code' });

  const order = await kv.get(`order:${code}`);
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });

  if (order.status === 'paid') {
    return res.json({
      status:    'paid',
      ebookLink: process.env.EBOOK_LINK,
      invoiceNo: order.invoiceNo,
      paidAt:    order.paidAt,
    });
  }

  return res.json({ status: 'pending' });
}
