import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'ไม่พบหน้านี้ · memory-hub' };

export default function NotFound() {
  return (
    <main className="fatal">
      <p>
        ไม่พบหน้านี้ — <a href="/">กลับไปหน้าสมองความจำ</a>
      </p>
    </main>
  );
}
