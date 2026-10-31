# For coding agents

This folder is the UI design of the Little Buddy parent website for one
Buddy, Miu the talking kitten: three pages (the marketing page, Create
account and Talk) and the Miu component, with the tokens and previews. It is
meant to be the starting point of a frontend built from scratch. Read
`INSTRUCTIONS.md` before changing anything here or building anything from
it: it has the design language, the pages, how the Talk page behaves, and
the rules enforced in review.

The short version of the rules:

- This folder is self-contained on purpose. It never names other folders,
  files, commits or repositories; it describes the website by its pages and
  addresses. Keep it that way.
- Miu is the only Buddy. Everything that draws Buddy draws Miu.
- No em dashes anywhere, the artboards' copy included. Use a colon, a comma
  or parentheses.
- Colours only through the tokens in `reference/tokens.css`; two fonts
  (Baloo 2 and Nunito); chunky pieces with a solid bottom lip; nothing
  animates on load and every animation stops under reduced motion.
- The website never shows the child's words; the Talk page is hands-free and
  never uses hold-to-talk or tap-to-talk wording.
- `preview/` is generated: edit `artboards/`, then run `node tools/render.mjs`
  from this folder.
