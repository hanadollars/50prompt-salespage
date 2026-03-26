import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Thiếu thông tin khách hàng' });
    }

    // Tạo mã đơn hàng ngẫu nhiên: 50P + 4 ký tự
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '50P';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const orderData = {
      code,
      name,
      email,
      amount: 149000,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    // Lưu vào Vercel KV với thời hạn 48 giờ
    await kv.set(`order:${code}`, JSON.stringify(orderData), { ex: 172800 });

    // Tạo VietQR URL cho ACB
    const acbAccount = process.env.ACB_ACCOUNT;
    const accountName = encodeURIComponent(process.env.ACCOUNT_NAME || 'HANADOLA');
    const description = encodeURIComponent(`Thanh toan ${code}`);
    const qrUrl = `https://img.vietqr.io/image/ACB-${acbAccount}-compact2.png?amount=149000&addInfo=${description}&accountName=${accountName}`;

    return res.status(200).json({
      success: true,
      orderCode: code,
      qrUrl,
      amount: 149000
    });

  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({ error: 'Lỗi tạo đơn hàng' });
  }
}
