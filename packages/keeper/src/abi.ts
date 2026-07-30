/**
 * The slice of the protocol a keeper touches.
 *
 * Hand-written rather than generated so this package stays independently buildable
 * from a public checkout: a keeper should be `npm i && npm start`, not a Foundry
 * toolchain and a compile step. The shapes are asserted against the compiled
 * artefacts in CI, so a signature change here fails the build rather than the
 * keeper.
 */
export const PLAN_ABI = [
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [{name: "index", type: "uint256"}],
    outputs: [
      {name: "cleared", type: "bool"},
      {name: "reason", type: "uint8"},
    ],
  },
  {
    type: "function",
    name: "collectBatch",
    stateMutability: "nonpayable",
    inputs: [{name: "indices", type: "uint256[]"}],
    outputs: [
      {name: "cleared", type: "bool[]"},
      {name: "reasons", type: "uint8[]"},
    ],
  },
  {type: "function", name: "markMissed", stateMutability: "nonpayable", inputs: [{name: "index", type: "uint256"}], outputs: []},
  {type: "function", name: "markExpired", stateMutability: "nonpayable", inputs: [{name: "index", type: "uint256"}], outputs: []},
  {type: "function", name: "halt", stateMutability: "nonpayable", inputs: [], outputs: []},
  {type: "function", name: "resume", stateMutability: "nonpayable", inputs: [], outputs: []},
  {type: "function", name: "planId", stateMutability: "view", inputs: [], outputs: [{type: "bytes32"}]},
  {type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{type: "uint8"}]},
  {type: "function", name: "borrower", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "installmentCount", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {type: "function", name: "markEscrow", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {type: "function", name: "dueDate", stateMutability: "view", inputs: [{name: "index", type: "uint256"}], outputs: [{type: "uint256"}]},
  {type: "function", name: "graceEndsAt", stateMutability: "view", inputs: [{name: "index", type: "uint256"}], outputs: [{type: "uint256"}]},
  {type: "function", name: "validBefore", stateMutability: "view", inputs: [{name: "index", type: "uint256"}], outputs: [{type: "uint256"}]},
  {type: "function", name: "installmentAmount", stateMutability: "view", inputs: [{name: "index", type: "uint256"}], outputs: [{type: "uint256"}]},
  {type: "function", name: "installmentStatus", stateMutability: "view", inputs: [{name: "index", type: "uint256"}], outputs: [{type: "uint8"}]},
  {type: "function", name: "bountyFor", stateMutability: "view", inputs: [{name: "index", type: "uint256"}], outputs: [{type: "uint256"}]},
  {
    type: "event",
    name: "CheckCleared",
    inputs: [
      {name: "planId", type: "bytes32", indexed: true},
      {name: "index", type: "uint256", indexed: true},
      {name: "amount", type: "uint256", indexed: false},
      {name: "keeper", type: "address", indexed: false},
    ],
  },
] as const;

export const FACTORY_ABI = [
  {
    type: "event",
    name: "PlanDeployed",
    inputs: [
      {name: "planId", type: "bytes32", indexed: true},
      {name: "plan", type: "address", indexed: true},
      {name: "implementation", type: "address", indexed: true},
    ],
  },
  {type: "function", name: "planOf", stateMutability: "view", inputs: [{type: "bytes32"}], outputs: [{type: "address"}]},
] as const;

export const TOKEN_ABI = [
  {type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{type: "bool"}]},
  {type: "function", name: "balanceOf", stateMutability: "view", inputs: [{type: "address"}], outputs: [{type: "uint256"}]},
] as const;
