import { createServer, request } from "node:http";

// Forward real node traffic without synchronizing coordinator shutdown to a poll.
export async function localRelay(targetPort) {
  const sockets = new Set(), observations = [];
  const server = createServer(async (incoming, response) => {
    const path = incoming.url;
    observations.push({ path, phase: "request", at: Date.now() });
    try {
      const upstream = request({ hostname: "127.0.0.1", port: targetPort, path, method: incoming.method, headers: incoming.headers }, (reply) => {
        observations.push({ path, phase: "response", status: reply.statusCode, at: Date.now() });
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
      });
      upstream.on("socket", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
      upstream.on("error", () => response.destroy());
      incoming.on("aborted", () => upstream.destroy());
      incoming.pipe(upstream);
    } catch { response.destroy(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, observations,
    retarget(port) { targetPort = port; for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
