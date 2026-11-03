// Gating math: an art index is revealable ONLY once the tokenId that maps to it is minted.
// Contract: tokenURI(tokenId) = baseURI + ((tokenId + startingIndex) % MAX) + ".json"  => art=(t+si)%MAX
// Inverse: tokenId = (art - si) mod MAX, with tokenIds in 1..MAX (0 -> MAX).
const MAX = 1000;
function artToToken(art, si){ let t = (art - si) % MAX; if (t < 0) t += MAX; if (t === 0) t = MAX; return t; }
function isLive(art, state){ if (!state.revealed) return false; const t = artToToken(art, state.si); return t >= 1 && t <= state.minted; }
module.exports = { MAX, artToToken, isLive };
