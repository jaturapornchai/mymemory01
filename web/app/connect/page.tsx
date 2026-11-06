import type { Metadata } from 'next';
import './connect.css';

// Public how-to (memory.bcaicloud.com/connect): addresses and steps only. The token and the secret per-app links never
// appear here — they stay on ลุงจืด's PC (~/.memhub), this page is served to anyone with no login.
const SITE = 'https://memory.bcaicloud.com';
const TITLE = 'เชื่อม AI จากเครื่องอื่นเข้ากับ memory-hub (MCP)';
const DESC = 'วิธีให้ Claude Code, Codex, Gemini CLI, Cursor, ChatGPT และ Claude.ai บนเครื่องอื่นค้นและบันทึกความจำเดียวกันผ่าน MCP';

export const metadata: Metadata = {
  title: `${TITLE} · memory-hub`,
  description: DESC,
  alternates: { canonical: `${SITE}/connect` },
  // a page's openGraph replaces the layout's whole object, so the share card fields are repeated here
  openGraph: { type: 'article', url: `${SITE}/connect`, siteName: 'memory-hub', locale: 'th_TH', title: TITLE, description: DESC, images: ['/og.png'] },
};

const FAQ = [
  ['ต้องเปิดเครื่องเจ้าของไว้ไหม', 'ต้องเปิด ความจำทั้งหมดอยู่ในเครื่องเจ้าของ เซิร์ฟเวอร์ memory.bcaicloud.com แค่ส่งต่อคำขอไปที่เครื่องนั้น ถ้าปิดเครื่อง AI ทุกตัวจะเชื่อมไม่ได้'],
  ['รหัสเข้าใช้ (token) อยู่ที่ไหน', 'อยู่ในไฟล์ ~/.memhub/mcp-token บนเครื่องเจ้าของเท่านั้น หน้านี้ไม่มีรหัส รหัสเปิดได้ทุกอย่างที่ที่อยู่นั้นเห็น ทั้งค้น อ่าน และบันทึก จึงห้ามแปะในแชต อีเมล หรือ git'],
  ['ChatGPT กับ Claude.ai ใส่หัวข้อรหัสไม่ได้ ทำยังไง', 'ใช้ลิงก์ลับเฉพาะแอปแทน ลิงก์อยู่ในไฟล์ ~/.memhub/chatgpt-mcp-url และ ~/.memhub/claude-ai-mcp-url บนเครื่องเจ้าของ ใส่ลิงก์นั้นเป็น connector แบบกำหนดเองในแอป'],
  ['ลิงก์ลับทำอะไรได้บ้าง', 'ค้นและอ่านความจำได้ บันทึกได้ครั้งละไม่เกิน 1,500 ตัวอักษร วันละไม่เกิน 30 ครั้งต่อลิงก์ และไม่เห็นข้อมูลที่ให้เฉพาะ Claude เช่น Google'],
] as const;

const LD = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'memory-hub', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'เชื่อม AI จากเครื่องอื่น', item: `${SITE}/connect` },
    ] },
    { '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ],
};

export default function Connect() {
  return (
    <main className="doc">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(LD) }} />
      <article className="doc__body">
        <nav className="doc__crumb" aria-label="ตำแหน่งหน้า">
          <a href="/">memory-hub</a> › เชื่อม AI จากเครื่องอื่น
        </nav>
        <h1>เชื่อม AI จากเครื่องอื่นเข้ากับ memory-hub</h1>
        <p className="doc__lead">
          memory-hub เปิดความจำผ่าน MCP ทางอินเทอร์เน็ต AI ที่อยู่คนละเครื่องจึงค้นและบันทึกความจำชุดเดียวกันได้ ต้องใช้รหัสเข้าใช้จากเครื่องเจ้าของ
          หน้านี้ไม่มีรหัส
        </p>

        <section aria-labelledby="c-url">
          <h2 id="c-url">1. เลือกที่อยู่ตามแอป</h2>
          <ul className="doc__cards">
            <li>
              <b>Claude Code</b>
              <code>{SITE}/mcp/claude</code>
              <span>เห็นทุกอย่าง รวมข้อมูลที่ให้เฉพาะ Claude</span>
            </li>
            <li>
              <b>แอปอื่น เช่น Codex, Gemini CLI, Cursor</b>
              <code>{SITE}/mcp</code>
              <span>เห็นทุกอย่าง ยกเว้นข้อมูลที่ให้เฉพาะ Claude (เช่น Google)</span>
            </li>
            <li>
              <b>ChatGPT, Claude.ai และ Claude Desktop</b>
              <span>ใช้ลิงก์ลับเฉพาะแอป ดูคำถามด้านล่าง</span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="c-token">
          <h2 id="c-token">2. คัดลอกรหัสจากเครื่องเจ้าของ</h2>
          <p>เปิด Git Bash บนเครื่องที่รัน memory-hub แล้วรันคำสั่งนี้ รหัสจะอยู่ในคลิปบอร์ด ไม่ขึ้นบนจอ</p>
          <pre><code>cat ~/.memhub/mcp-token | clip</code></pre>
          <p>ส่งรหัสไปเครื่องอื่นด้วยช่องทางที่ปลอดภัย และวางในขั้นที่ 3 แทนคำว่า <code>&lt;รหัส&gt;</code></p>
        </section>

        <section aria-labelledby="c-app">
          <h2 id="c-app">3. ตั้งค่าในแอป</h2>
          <p>Claude Code: รันคำสั่งนี้บนเครื่องนั้นครั้งเดียว ใช้ได้ทุกโปรเจกต์</p>
          <pre><code>claude mcp add --transport http --scope user memory-hub {SITE}/mcp/claude --header &quot;Authorization: Bearer &lt;รหัส&gt;&quot;</code></pre>
          <p>
            แอปอื่น: เพิ่ม MCP server แบบ HTTP ในหน้าตั้งค่าของแอป ใส่ที่อยู่ <code>{SITE}/mcp</code> และหัวข้อ{' '}
            <code>Authorization: Bearer &lt;รหัส&gt;</code>
          </p>
        </section>

        <section aria-labelledby="c-faq">
          <h2 id="c-faq">คำถามที่พบบ่อย</h2>
          <dl className="doc__faq">
            {FAQ.map(([q, a]) => (
              <div key={q}>
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="doc__back">
          <a href="/">← กลับไปหน้าสมองความจำ</a>
        </p>
      </article>
    </main>
  );
}
