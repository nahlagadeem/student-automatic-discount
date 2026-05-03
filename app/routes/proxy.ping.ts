export async function loader() {
  return new Response("proxy pong", { headers: { "Content-Type": "text/plain" } });
}

