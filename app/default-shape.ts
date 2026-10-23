// A procedurally drawn gingerbread man (a nod to Figure 1 of the paper) on a
// transparent canvas, so the plaything works without any external image.
export function makeDefaultShape(size = 512): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const s = size / 512;
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const body = (width: number, color: string) => {
    ctx.strokeStyle = color; ctx.fillStyle = color;
    // head
    ctx.beginPath(); ctx.arc(256, 112, 58 + width / 2, 0, Math.PI * 2); ctx.fill();
    // torso
    ctx.lineWidth = 118 + width;
    ctx.beginPath(); ctx.moveTo(256, 196); ctx.lineTo(256, 300); ctx.stroke();
    // arms
    ctx.lineWidth = 54 + width;
    ctx.beginPath(); ctx.moveTo(250, 212); ctx.lineTo(100, 262); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(262, 212); ctx.lineTo(412, 262); ctx.stroke();
    // legs
    ctx.lineWidth = 60 + width;
    ctx.beginPath(); ctx.moveTo(246, 300); ctx.lineTo(178, 440); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(266, 300); ctx.lineTo(334, 440); ctx.stroke();
  };
  body(10, '#6b3a16');   // dark outline
  body(0, '#c4823f');    // cookie

  // icing
  ctx.strokeStyle = '#fff6e8'; ctx.fillStyle = '#fff6e8'; ctx.lineWidth = 6;
  const cuff = (x: number, y: number, dx: number, dy: number) => {
    // a zig-zag perpendicular to the limb direction (dx, dy)
    const len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len, ux = dx / len, uy = dy / len;
    ctx.beginPath();
    for (let i = -4; i <= 4; i++) {
      const t = i * 5, z = (i % 2 ? 1 : -1) * 4;
      const px = x + nx * t + ux * z, py = y + ny * t + uy * z;
      if (i === -4) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  cuff(122, 254, -150, 50); cuff(390, 254, 150, 50);
  cuff(190, 414, -68, 140); cuff(322, 414, 68, 140);
  // eyes
  for (const x of [238, 274]) {
    ctx.beginPath(); ctx.arc(x, 104, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b1708'; ctx.beginPath(); ctx.arc(x + 1, 105, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff6e8';
  }
  // smile
  ctx.beginPath(); ctx.arc(256, 118, 26, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
  // buttons
  for (const y of [215, 250, 285]) {
    ctx.beginPath(); ctx.arc(256, y, 8, 0, Math.PI * 2); ctx.fill();
  }
  // bow tie
  ctx.fillStyle = '#d6303e';
  ctx.beginPath(); ctx.moveTo(256, 184); ctx.lineTo(232, 172); ctx.lineTo(232, 196); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(256, 184); ctx.lineTo(280, 172); ctx.lineTo(280, 196); ctx.closePath(); ctx.fill();
  return c;
}
