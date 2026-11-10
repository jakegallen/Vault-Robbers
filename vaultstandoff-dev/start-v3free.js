// V3 FREE-PLAY (The Vault Standoff): the retirement archive of Vault Standoff (Jake 2026-11-10, retirement pivot).
// Boots the Standoff build as a FREE, WALLET-FREE, no-chain solo-vs-AI game. Standoff shipped a self-contained,
// client-side PRACTICE heist (the exact live rules, simulated opponents, a fake display pot) that touches NO escrow,
// NO wallet, NO live round and makes NO server game call. This entry point makes that practice heist the WHOLE game.
//
//   VS_FREE_ONLY=1  ->  server: no play-password gate, index.html served with window.VS_FREE_ONLY=true injected.
//                       client: skips /api/join + the live poll entirely, hides every buy-in/connect/pot control,
//                       and boots straight into the solo-vs-AI practice arc (filling lobby, chambers, sudden
//                       death, ceremony, "Play again"). The end screen "Play for real" funnel is stripped.
//
// Deliberately NOT set: VS_ESCROW (stays OFF, so no money engine, no keys, no mainnet exposure) and VS_PASSWORD
// (the gate is bypassed in free mode anyway). Only this entry point sets VS_FREE_ONLY, so the real-money dev/prod
// builds (their own start scripts) keep their password gate + wallet flow byte-for-byte.
process.env.VS_FREE_ONLY = '1';
require('./server.js');
