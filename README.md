# ccr-store

Bounded LRU store for CCR (Compressed Content Recovery) chunks — the recovery half of token-funnel's funnelReversible(). Lets any cartridge compress bulk tool output to a budget while keeping every removed chunk expandable by its <<ccr:HASH>> marker, instead of choosing between a context blowout and a silent drop.

## Install

```bash
npm install ccr-store
```  

## License

MIT
