# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/septirifai7-hub/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/septirifai7-hub/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-money trading bot for pump.fun style Solana markets: it reads replayed market events as they arrive, buys fresh bonding curves only when the tape shows real buy pressure (most recent SOL flowing in from several distinct buyers, price rising near its window high), pyramids into strength, and cuts every position with a hard stop-loss, a trailing stop, a take-profit, and a maximum hold time. Paper money only — it never touches a real wallet, real SOL, or any live network. Made for the make.fun bounty `u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed` by the account @rifai-septi.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout: the harness sends a hello message and one batch per slot, and the bot answers each batch with its orders. Run it locally against the kit's dev window with `node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process` from inside the unpacked kit.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zyyqqmfs&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
