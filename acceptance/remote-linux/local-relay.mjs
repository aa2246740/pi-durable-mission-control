import { createServer, request } from "node:http";

// The local relay can hold one real assignment poll at the SIGTERM boundary.
// It never fabricates node requests, responses, stop reports or acknowledgements.
export async function localRelay(targetPort) {
  const sockets = new Set(), observations = [];
  let gate;
  const server = createServer(async (incoming, response) => {
    const path = incoming.url;
    observations.push({ path, phase: "request", at: Date.now() });
    try {
      if (gate && path === "/api/nodes/runtimes/poll") {
        const pending = gate; gate = undefined;
        try { await pending.action(); pending.resolve(); }
        catch (error) { pending.reject(error); throw error; }
      }
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
    atRuntimePoll(action) {
      if (gate) throw new Error("A runtime poll gate is already armed");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { gate = undefined; reject(new Error("No runtime poll reached the graceful-stop gate")); }, 10000);
        gate = { action, resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      });
    },
    retarget(port) { targetPort = port; for (const socket of sockets) socket.destroy(); },
    async close() {
      if (gate) { gate.reject(new Error("Relay closed before runtime poll")); gate = undefined; }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
