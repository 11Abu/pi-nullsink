# Records the README demo GIF. Regenerate with:  vhs scripts/demo/demo.tape
# (installs: `brew install vhs`).  The tour is driven by scripts/demo/hub-demo.ts —
# the real hub renderer against fixture data, no pi runtime and no real money.
Output "assets/demo.gif"

Set FontSize 14
Set Width 920
Set Height 620
Set Padding 24
Set Framerate 24

Hide
Type "bun run scripts/demo/hub-demo.ts"
Enter
Sleep 1s
Show
Sleep 28s
