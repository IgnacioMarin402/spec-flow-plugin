// The answers the hooks (Go) and the live view (live-view-readers.ts) give
// for the same input. Both read this table: a reader changed in one place
// fails until the other agrees. `null` is no answer: no return block, no
// milestone, a cap that is not a whole number of calls.
export default {
  "maxBlocks": 2,
  "keep": 10000,
  "budgets": {
    "planner": {
      "key": "max_opus_calls",
      "fallback": 6,
      "counter": "opus_calls"
    },
    "architect": {
      "key": "max_architect_calls",
      "fallback": 3,
      "counter": "architect_calls"
    }
  },
  "parseReturn": [
    {
      "text": "Done.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\nSUMMARY: two lines\n```\nSTATUS: NOT_THIS\n",
      "want": {
        "status": "SPEC_READY",
        "fields": {
          "SPEC_PATH": "specflow/x/spec.md",
          "SUMMARY": "two lines"
        }
      }
    },
    {
      "text": "no block here",
      "want": null
    },
    {
      "text": "The previous round ended with STATUS: NEEDS_INPUT; the answers are in.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\n```",
      "want": {
        "status": "SPEC_READY",
        "fields": {
          "SPEC_PATH": "specflow/x/spec.md"
        }
      }
    },
    {
      "text": "**STATUS:** APPROVED\n**NOTES:** none",
      "want": {
        "status": "APPROVED",
        "fields": {
          "NOTES": "none"
        }
      }
    },
    {
      "text": "STATUS: **APPROVED**",
      "want": {
        "status": "APPROVED",
        "fields": {}
      }
    },
    {
      "text": "The plan header says STATUS: N/A.",
      "want": null
    },
    {
      "text": "> STATUS: CHANGES_REQUESTED\r\n> CHANGES: tighten M2\r\n> CHANGES: not this one\r\n",
      "want": {
        "status": "CHANGES_REQUESTED",
        "fields": {
          "CHANGES": "tighten M2"
        }
      }
    },
    {
      "text": "## STATUS: ESCALATE\nQUESTION:   which store?  \n```\nAFTER: fence\n",
      "want": {
        "status": "ESCALATE",
        "fields": {
          "QUESTION": "which store?"
        }
      }
    }
  ],
  "projectConfig": [
    {
      "text": "",
      "settings": {},
      "problem": ""
    },
    {
      "text": "  \n",
      "settings": {},
      "problem": ""
    },
    {
      "text": "﻿",
      "settings": {},
      "problem": ""
    },
    {
      "text": "﻿{\"max_opus_calls\": 2}",
      "settings": {
        "max_opus_calls": 2
      },
      "problem": ""
    },
    {
      "text": "{ \"max_opus_calls\": 2, }",
      "settings": {},
      "problem": "parse"
    },
    {
      "text": "null",
      "settings": {},
      "problem": "object"
    },
    {
      "text": "[]",
      "settings": {},
      "problem": "object"
    },
    {
      "text": "6",
      "settings": {},
      "problem": "object"
    },
    {
      "text": "\"six\"",
      "settings": {},
      "problem": "object"
    },
    {
      "text": "{\"agents\":{\"reviewer\":\"haiku\"}}",
      "settings": {
        "agents": {
          "reviewer": "haiku"
        }
      },
      "problem": ""
    }
  ],
  "budgetCap": [
    {
      "text": "{\"max_architect_calls\":true}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":false}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":[5]}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":[]}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"\"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"  \"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"six\"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":{}}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":-1}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":2.5}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"2.5\"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"0x10\"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"1e1\"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":\"-1\"}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":null}",
      "role": "architect",
      "want": null
    },
    {
      "text": "{\"max_architect_calls\":0}",
      "role": "architect",
      "want": 0
    },
    {
      "text": "{\"max_architect_calls\":3}",
      "role": "architect",
      "want": 3
    },
    {
      "text": "{\"max_architect_calls\":\"4\"}",
      "role": "architect",
      "want": 4
    },
    {
      "text": "{\"max_architect_calls\":\" 5 \"}",
      "role": "architect",
      "want": 5
    },
    {
      "text": "",
      "role": "planner",
      "want": 6
    },
    {
      "text": "{ not json",
      "role": "planner",
      "want": 6
    },
    {
      "text": "{}",
      "role": "planner",
      "want": 6
    },
    {
      "text": "null",
      "role": "planner",
      "want": 6
    },
    {
      "text": "[]",
      "role": "planner",
      "want": 6
    },
    {
      "text": "6",
      "role": "planner",
      "want": 6
    },
    {
      "text": "﻿{\"max_opus_calls\": 2}",
      "role": "planner",
      "want": 2
    },
    {
      "text": "",
      "role": "architect",
      "want": 3
    },
    {
      "text": "﻿{\"max_architect_calls\": \"three\"}",
      "role": "architect",
      "want": null
    }
  ],
  "milestoneRef": [
    {
      "prompt": "implement specflow/add-users/milestones/M2.md per the plan",
      "want": {
        "change": "add-users",
        "milestone": "M2"
      }
    },
    {
      "prompt": "implement C:\\repo\\specflow\\add-users\\milestones\\M2.md",
      "want": {
        "change": "add-users",
        "milestone": "M2"
      }
    },
    {
      "prompt": "`specflow/add-users/milestones/M12.md`",
      "want": {
        "change": "add-users",
        "milestone": "M12"
      }
    },
    {
      "prompt": "see docs/milestones/M1.md, then implement specflow/add-users/milestones/M2.md",
      "want": {
        "change": "add-users",
        "milestone": "M2"
      }
    },
    {
      "prompt": "after milestones/M1.md, implement specflow/add-users/milestones/M2.md",
      "want": {
        "change": "add-users",
        "milestone": "M2"
      }
    },
    {
      "prompt": "re-read plan.md and milestones/M3.md",
      "want": {
        "change": "",
        "milestone": "M3"
      }
    },
    {
      "prompt": "re-read `milestones\\M3.md`",
      "want": {
        "change": "",
        "milestone": "M3"
      }
    },
    {
      "prompt": "see docs/milestones/M1.md",
      "want": null
    },
    {
      "prompt": "see ./milestones/M1.md",
      "want": null
    },
    {
      "prompt": "implement the plan",
      "want": null
    },
    {
      "prompt": "specflow/add-users/plan.md",
      "want": null
    },
    {
      "prompt": null,
      "want": null
    },
    {
      "prompt": {
        "prompt": "specflow/add-users/milestones/M2.md"
      },
      "want": null
    }
  ],
  "linesOf": [
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": " agent-check ",
      "since": 0,
      "want": {
        "n": 3,
        "last": [
          "2026-10-17T04:00:00.000Z phase=implement agent-check i=0",
          "2026-10-17T04:45:00.123Z phase=implement agent-check i=2",
          "2026-10-17T05:00:00Z phase=done agent-check i=3"
        ]
      }
    },
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": "",
      "since": 1792211400000,
      "want": {
        "n": 3,
        "last": [
          "2026-10-17T04:30:00Z phase=implement tool=Read i=1",
          "2026-10-17T04:45:00.123Z phase=implement agent-check i=2",
          "2026-10-17T05:00:00Z phase=done agent-check i=3"
        ]
      }
    },
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": "",
      "since": 0,
      "want": {
        "n": 4,
        "last": [
          "2026-10-17T04:00:00.000Z phase=implement agent-check i=0",
          "2026-10-17T04:30:00Z phase=implement tool=Read i=1",
          "2026-10-17T04:45:00.123Z phase=implement agent-check i=2",
          "2026-10-17T05:00:00Z phase=done agent-check i=3"
        ]
      }
    },
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": "nothing has this",
      "since": 0,
      "want": {
        "n": 0,
        "last": []
      }
    },
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": "",
      "since": "-Infinity",
      "want": {
        "n": 6,
        "last": [
          "2026-10-17T04:00:00.000Z phase=implement agent-check i=0",
          "no stamp agent-check",
          "2026-10-17T04:30:00Z phase=implement tool=Read i=1",
          "2026-10-17T04:45:00.123Z phase=implement agent-check i=2",
          "not-a-date agent-check",
          "2026-10-17T05:00:00Z phase=done agent-check i=3"
        ]
      }
    },
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": "agent-check",
      "since": "-Infinity",
      "want": {
        "n": 5,
        "last": [
          "2026-10-17T04:00:00.000Z phase=implement agent-check i=0",
          "no stamp agent-check",
          "2026-10-17T04:45:00.123Z phase=implement agent-check i=2",
          "not-a-date agent-check",
          "2026-10-17T05:00:00Z phase=done agent-check i=3"
        ]
      }
    },
    {
      "text": "2026-10-17T04:00:00.000Z phase=implement agent-check i=0\r\n\r\nno stamp agent-check\r\n2026-10-17T04:30:00Z phase=implement tool=Read i=1\r\n2026-10-17T04:45:00.123Z phase=implement agent-check i=2\r\nnot-a-date agent-check\r\n2026-10-17T05:00:00Z phase=done agent-check i=3\r\n",
      "needle": "phase=",
      "since": 1792211400001,
      "want": {
        "n": 2,
        "last": [
          "2026-10-17T04:45:00.123Z phase=implement agent-check i=2",
          "2026-10-17T05:00:00Z phase=done agent-check i=3"
        ]
      }
    }
  ]
}
