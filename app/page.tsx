import Link from "next/link";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "sans-serif" }}>
      <Link href="/travel/">进入智能旅游助手</Link>
    </main>
  );
}
