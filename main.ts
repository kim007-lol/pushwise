// PUSHWISE: a Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// Strategy: the levels are a hallway with independent rooms off it. Each room is solved
// on its own with push-A* (cost = pushes, admissible matching heuristic, deadlock pruning),
// and the rooms are stitched together with hallway walks. Deterministic: fixed expansion
// budgets, never the clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budget per room. No clock reads anywhere: the same input always yields the
// same output, because the search stops on expansions, never on time.
const ROOM_BUDGET = 1_000_000;

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];
const PUSH_LETTER = ['U', 'D', 'L', 'R'];

interface Level {
  w: number;
  h: number;
  wall: boolean[]; // true = wall (or outside the level)
  goals: Set<number>;
  boxes: number[];
  player: number;
  hallRow: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = 0;
  let hallRow = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y]![x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.add(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') {
        player = i;
        hallRow = y;
      }
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player, hallRow };
}

// A room: its floor cells, its boxes, its goals, the door (the room cell next to the
// hallway) and the entry square (the hallway cell next to the door).
interface Room {
  floor: Set<number>;
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
}

function findRooms(lv: Level): Room[] {
  const { w, h, wall, hallRow } = lv;
  const seen = new Set<number>();
  const rooms: Room[] = [];
  const isFloor = (i: number): boolean => i >= 0 && i < w * h && !wall[i];
  // Candidate doors: floor cells directly above or below the hallway row.
  for (const dy of [-1, 1]) {
    const r = hallRow + dy;
    if (r < 0 || r >= h) continue;
    for (let x = 0; x < w; x++) {
      const door = r * w + x;
      if (!isFloor(door) || seen.has(door)) continue;
      const entry = hallRow * w + x;
      if (!isFloor(entry)) continue;
      // Flood-fill the room: every floor cell reachable from the door without crossing
      // the hallway row.
      const floor = new Set<number>();
      const stack = [door];
      seen.add(door);
      floor.add(door);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % w;
        const cy = Math.floor(cur / w);
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || ny === hallRow) continue;
          const ni = ny * w + nx;
          if (!isFloor(ni) || floor.has(ni)) continue;
          floor.add(ni);
          seen.add(ni);
          stack.push(ni);
        }
      }
      const boxes = lv.boxes.filter((b) => floor.has(b)).sort((a, b) => a - b);
      const goals = [...lv.goals].filter((g) => floor.has(g)).sort((a, b) => a - b);
      rooms.push({ floor, boxes, goals, door, entry });
    }
  }
  return rooms;
}

// Breadth-first search over a set of allowed cells, with extra blocked cells (boxes).
// Returns the shortest move string from start to target, or null if unreachable.
function bfsPath(
  w: number,
  allowed: (i: number) => boolean,
  blocked: Set<number>,
  start: number,
  target: number,
): string | null {
  if (start === target) return '';
  const prev = new Map<number, { from: number; letter: string }>();
  const queue = [start];
  prev.set(start, { from: -1, letter: '' });
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || ny < 0) continue;
      const ni = ny * w + nx;
      if (prev.has(ni) || blocked.has(ni) || !allowed(ni)) continue;
      prev.set(ni, { from: cur, letter: LETTER[d]! });
      if (ni === target) {
        let out = '';
        let t = ni;
        while (prev.get(t)!.from !== -1) {
          out = prev.get(t)!.letter + out;
          t = prev.get(t)!.from;
        }
        return out;
      }
      queue.push(ni);
    }
  }
  return null;
}

// Flood-fill the player's reachable region (allowed cells minus blocked cells).
function reachableRegion(
  w: number,
  allowed: (i: number) => boolean,
  blocked: Set<number>,
  start: number,
): Set<number> {
  const region = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || ny < 0) continue;
      const ni = ny * w + nx;
      if (region.has(ni) || blocked.has(ni) || !allowed(ni)) continue;
      region.add(ni);
      stack.push(ni);
    }
  }
  return region;
}

// Grid distances from one goal over the room floor (walls = anything not in the room).
function goalDistances(w: number, h: number, floor: Set<number>, goal: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== -1 || !floor.has(ni)) continue;
      dist[ni] = dist[cur]! + 1;
      queue.push(ni);
    }
  }
  return dist;
}

// Deadlock test for one box configuration. A box not on a goal is dead when it sits in a
// corner (two perpendicular walls) or on a wall segment with no goal that it cannot leave.
function isDead(
  w: number,
  floor: Set<number>,
  goals: Set<number>,
  boxes: number[],
): boolean {
  for (const b of boxes) {
    if (goals.has(b)) continue;
    const x = b % w;
    const y = Math.floor(b / w);
    const wallAt = (dx: number, dy: number): boolean => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0) return true;
      return !floor.has(ny * w + nx);
    };
    // Corner: two perpendicular walls.
    if (
      (wallAt(0, -1) && wallAt(-1, 0)) ||
      (wallAt(0, -1) && wallAt(1, 0)) ||
      (wallAt(0, 1) && wallAt(-1, 0)) ||
      (wallAt(0, 1) && wallAt(1, 0))
    ) {
      return true;
    }
    // Wall segment: box against a wall, sliding along it, with no goal on the segment
    // and no way off the segment at either end.
    const wallDirs: [number, number, number, number][] = [
      [0, -1, 1, 0], // wall to the north, slide east/west
      [0, 1, 1, 0], // wall to the south, slide east/west
      [-1, 0, 0, 1], // wall to the west, slide north/south
      [1, 0, 0, 1], // wall to the east, slide north/south
    ];
    for (const [wx, wy, sx, sy] of wallDirs) {
      if (!wallAt(wx, wy)) continue;
      let hasGoal = goals.has(b);
      let openEnd = false;
      for (const sign of [1, -1]) {
        let step = 1;
        for (;;) {
          const nx = x + sx * sign * step;
          const ny = y + sy * sign * step;
          if (nx < 0 || ny < 0) break;
          const ni = ny * w + nx;
          if (!floor.has(ni)) break; // segment bounded by a wall here
          // If this square is not against the same wall, the box can leave the wall.
          const bx2 = nx + wx;
          const by2 = ny + wy;
          if (bx2 >= 0 && bx2 < w && by2 >= 0 && floor.has(by2 * w + bx2)) {
            openEnd = true;
            break;
          }
          if (goals.has(ni)) hasGoal = true;
          step++;
        }
        if (openEnd) break;
      }
      if (!openEnd && !hasGoal) return true;
    }
  }
  return false;
}

// Push-A* for one room. Returns the move string (walks + pushes + exit walk) or null
// when the room is not solved within budget.
function solveRoom(lv: Level, room: Room): string | null {
  const { w, h } = lv;
  const { floor, goals, entry } = room;
  const goalSet = new Set(goals);
  const n = room.boxes.length;
  // The search area: room floor plus the entry square. Boxes never leave the room floor.
  const area = new Set<number>(floor);
  area.add(entry);
  const inArea = (i: number): boolean => area.has(i);

  // Precompute per-goal grid distances for the matching heuristic.
  const dists = goals.map((g) => goalDistances(w, h, floor, g));
  const INF = 1 << 28;
  // Min-cost matching between boxes and goals (brute force over permutations, n <= 4).
  const heuristic = (boxes: number[]): number => {
    const perm = goals.map((_, i) => i);
    let best = INF;
    const rec = (k: number, acc: number): void => {
      if (acc >= best) return;
      if (k === n) {
        best = acc;
        return;
      }
      for (let j = k; j < n; j++) {
        [perm[k], perm[j]] = [perm[j]!, perm[k]!];
        const d = dists[perm[k]!]![boxes[k]!]!;
        if (d >= 0) rec(k + 1, acc + d);
        [perm[k], perm[j]] = [perm[j]!, perm[k]!];
      }
    };
    rec(0, 0);
    return best;
  };

  // Node storage (parallel arrays). Each node: boxes, player position, pushes so far,
  // parent node, and the push (box cell before the push, direction) that created it.
  const nBoxes: number[][] = [room.boxes.slice()];
  const nPlayer: number[] = [entry];
  const nG: number[] = [0];
  const nParent: number[] = [-1];
  const nPushBox: number[] = [-1];
  const nPushDir: number[] = [-1];

  const stateKey = (boxes: number[], player: number): string => {
    const region = reachableRegion(w, inArea, new Set(boxes), player);
    let min = Infinity;
    for (const c of region) if (c < min) min = c;
    return boxes.join(',') + '|' + min;
  };

  const best = new Map<string, number>();
  best.set(stateKey(room.boxes, entry), 0);
  // Binary heap on (f, -g, seq): lowest f first, deepest first on ties, then insertion
  // order. All deterministic.
  type HeapEntry = [number, number, number, number]; // f, -g, seq, node
  const heap: HeapEntry[] = [];
  let seq = 0;
  const less = (a: HeapEntry, b: HeapEntry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: HeapEntry): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): HeapEntry => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(room.boxes);
  if (h0 >= INF) return null;
  heapPush([h0, 0, seq++, 0]);

  let expanded = 0;
  let goalNode = -1;
  while (heap.length > 0 && expanded < ROOM_BUDGET) {
    const [, , , s] = heapPop();
    const boxes = nBoxes[s]!;
    const player = nPlayer[s]!;
    const g = nG[s]!;
    if (best.get(stateKey(boxes, player)) !== g) continue;
    if (boxes.every((b) => goalSet.has(b))) {
      goalNode = s;
      break;
    }
    expanded++;
    const boxSet = new Set(boxes);
    const region = reachableRegion(w, inArea, boxSet, player);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const px = bx - DX[d]!;
        const py = by - DY[d]!;
        const tx = bx + DX[d]!;
        const ty = by + DY[d]!;
        if (px < 0 || py < 0 || tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const pushPos = py * w + px;
        const dest = ty * w + tx;
        if (!region.has(pushPos)) continue;
        if (!floor.has(dest) || boxSet.has(dest)) continue; // boxes stay in the room
        const nb = boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        if (isDead(w, floor, goalSet, nb)) continue;
        const hh = heuristic(nb);
        if (hh >= INF) continue;
        const np = b; // the player ends up where the box was
        const key = stateKey(nb, np);
        const seenG = best.get(key);
        if (seenG !== undefined && seenG <= g + 1) continue;
        const t = nBoxes.length;
        nBoxes.push(nb);
        nPlayer.push(np);
        nG.push(g + 1);
        nParent.push(s);
        nPushBox.push(b);
        nPushDir.push(d);
        best.set(key, g + 1);
        heapPush([g + 1 + hh, -(g + 1), seq++, t]);
      }
    }
  }
  if (goalNode < 0) return null;

  // Reconstruct the push list from the goal node back to the root.
  const pushes: { box: number; dir: number }[] = [];
  for (let t = goalNode; nParent[t]! >= 0; t = nParent[t]!) {
    pushes.push({ box: nPushBox[t]!, dir: nPushDir[t]! });
  }
  pushes.reverse();

  // Fill in the walks between pushes, then the exit walk to the entry square.
  let moves = '';
  let player = entry;
  let boxes = room.boxes.slice();
  for (const push of pushes) {
    const bx = push.box % w;
    const by = Math.floor(push.box / w);
    const pushPos = (by - DY[push.dir]!) * w + (bx - DX[push.dir]!);
    const walk = bfsPath(w, inArea, new Set(boxes), player, pushPos);
    if (walk === null) return null; // should not happen: the search verified reachability
    moves += walk;
    moves += PUSH_LETTER[push.dir]!;
    const bi = boxes.indexOf(push.box);
    boxes[bi] = (by + DY[push.dir]!) * w + (bx + DX[push.dir]!);
    boxes.sort((a, b2) => a - b2);
    player = push.box;
  }
  const exit = bfsPath(w, inArea, new Set(boxes), player, entry);
  if (exit === null) return null;
  moves += exit;
  return moves;
}

// Solve one whole level: visit rooms nearest-first, walking the hallway between doors.
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = findRooms(lv);
  if (rooms.length === 0) return '';
  const { w, hallRow } = lv;
  const hallSquares = new Set<number>();
  for (let x = 0; x < w; x++) {
    const i = hallRow * w + x;
    if (!lv.wall[i]) hallSquares.add(i);
  }
  const inHall = (i: number): boolean => hallSquares.has(i);
  let moves = '';
  let player = lv.player;
  const remaining = rooms.slice();
  while (remaining.length > 0) {
    // Pick the nearest unvisited room by hallway distance from the player.
    let bestIdx = -1;
    let bestWalk: string | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const walk = bfsPath(w, inHall, new Set<number>(), player, remaining[i]!.entry);
      if (walk !== null && (bestWalk === null || walk.length < bestWalk.length)) {
        bestIdx = i;
        bestWalk = walk;
      }
    }
    if (bestIdx < 0 || bestWalk === null) return '';
    const room = remaining.splice(bestIdx, 1)[0]!;
    const roomMoves = solveRoom(lv, room);
    if (roomMoves === null) return '';
    moves += bestWalk + roomMoves;
    player = room.entry;
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
