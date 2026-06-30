// Static browser build of the trivial direct-path game (M5). A top-down auto-play of the GDS's
// core loop — the runner walks to the relic, collects it, and WINS — rendered to a 2D canvas and
// publishing live state to window.__LIMINA_DIAGNOSTICS__ each frame (the contract the Playwright
// tier-2 gate reads). The win LOGIC mirrors the GDS's collect-wins DoD; the renderer is a
// lightweight 2D stand-in (the full WebGPU engine in-browser is the Mode-B/export path).
(function () {
  "use strict";
  var gdsEl = document.getElementById("gds");
  var gds = gdsEl ? JSON.parse(gdsEl.textContent) : { id: "game", loopSentence: "" };

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var W = canvas.width;
  var H = canvas.height;

  var player = { x: W / 2, y: 64 };
  var relic = { x: W / 2, y: H - 72 };
  var SPEED = 3.5;
  var REACH = 22;

  var frame = 0;
  var collected = false;
  var gameState = "running";
  var counters = { relics: 0 };

  function publish() {
    window.__LIMINA_DIAGNOSTICS__ = {
      frame: frame,
      gameState: gameState,
      counters: counters,
      complete: gameState !== "running",
      player: { x: player.x, z: player.y },
    };
  }

  function step() {
    if (collected) return;
    var dx = relic.x - player.x;
    var dy = relic.y - player.y;
    var d = Math.hypot(dx, dy);
    if (d > REACH) {
      player.x += (dx / d) * SPEED;
      player.y += (dy / d) * SPEED;
    } else {
      // The transition the gate asserts: collect -> counter advances -> game wins.
      collected = true;
      counters.relics = 1;
      gameState = "won";
    }
  }

  function draw() {
    ctx.fillStyle = "#10131a";
    ctx.fillRect(0, 0, W, H);

    // Relic glow (focal point) + core.
    var glow = ctx.createRadialGradient(relic.x, relic.y, 2, relic.x, relic.y, 30);
    glow.addColorStop(0, collected ? "#7CFC9A" : "#F5C84B");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(relic.x, relic.y, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = collected ? "#3a7d52" : "#caa23a";
    ctx.beginPath();
    ctx.arc(relic.x, relic.y, 9, 0, Math.PI * 2);
    ctx.fill();

    // Player.
    ctx.fillStyle = "#5AA9FF";
    ctx.beginPath();
    ctx.arc(player.x, player.y, 11, 0, Math.PI * 2);
    ctx.fill();

    if (gameState === "won") {
      ctx.fillStyle = "#7CFC9A";
      ctx.font = "bold 40px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("YOU WIN", W / 2, H / 2);
      ctx.textAlign = "start";
    }
  }

  function loop() {
    frame++;
    step();
    draw();
    publish();
    requestAnimationFrame(loop);
  }

  publish();
  draw();
  requestAnimationFrame(loop);
})();
