# Event fixtures

These fixtures preserve event order and timing intervals from recorded bb runs. They cover parent/subagent ordering, provider limits, restarts, duplicate turn endings, and background wake-ups.

Identifiers are stable substitutes, timestamps are shifted to an arbitrary epoch, and provider error messages are generic. Conversation text is absent. Sequence numbers and gaps are retained because incremental event folding depends on them.
