import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orderCode } = req.query;

    if (!orderCode) {
      return res.status(400).json({ error: 'Thiếu mã đơn hàng' });
    }

    const orderRaw = await kv.get(`order:${orderCode}`);

    if (!orderRaw) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    const order = typeof orderRaw === 'string' ? JSON.parse(orderRaw) : orderRaw;

    if (order.status === 'paid') {
      return res.status(200).json({
        status: 'paid',
        ebookLink: process.env.EBOOK_LINK,
        orderCode: order.code,
        name: order.name
      });
    }

    return res.status(200).json({ status: 'pending' });

  } catch (error) {
    console.error('Check payment error:', error);
    return res.status(500).json({ error: 'Lỗi kiểm tra thanh toán' });
  }
}
