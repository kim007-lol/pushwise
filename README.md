# PUSHWISE

A Sokoban solver for make.fun's `sokoban-solver-01-run-20261121` bounty. It answers
all 5 instances of a set in one run, in as few pushes as possible.

## How it works

The levels are a hallway with independent rooms off it, and a box pushed out of a room
can never come back, so each room is solved on its own and the rooms are stitched
together with hallway walks.

1. **Parse and split.** The level is parsed from XSB. The hallway is the row the player
   starts on. Each room is the floor region reachable from its door without crossing the
   hallway; each room has one door and one entry square in the hallway.
2. **Push-A\* per room.** From the entry state (player at the door, boxes at their start)
   to all boxes on goals. Cost is pushes, not moves. The heuristic is the min-cost
   matching between boxes and goals over precomputed grid distances (admissible, so the
   search is push-optimal). Dead states are pruned: corner deadlocks (a box in a corner
   that is not a goal) and wall deadlocks (a box on a wall segment with no goal that it
   cannot leave). Boxes are never pushed out of a room.
3. **Stitch.** Rooms are visited nearest-first from the player's position. The player
   walks the hallway to a room's entry square, enters, executes the room's solution, and
   walks back out through the door. Between pushes, the player's walks are filled in with
   BFS (boxes as obstacles), so the output is a full LURD move sequence.

## Determinism

The search budget is a fixed expansion count per room (1,000,000), never the clock.
No wall-clock reads, no randomness, no environment-dependent behaviour. Two runs on the
same set produce byte-identical outputs.

## Practice results

On the kit's practice set, PUSHWISE solves all 5 instances at their push-optimal counts
(P\*): i001 13, i002 16, i003 29, i004 47, i005 60. Total score 1,000,000 out of
1,000,000, in about 0.6 seconds. The house baseline (plain-astar) scores 200,000 on the
same set (only i001 solved). PUSHWISE also scores 1,000,000 on three fresh sets drawn
from the kit generator with random seeds.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt`, writes `/output/<id>/solution.txt` for each instance.
Node 22, standard library only, no network.
