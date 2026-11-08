# Contributing

Thanks for helping out. Scratchpad is a small project I run for my own group, so the process is light.

## Branches

- **`dev`** is where work happens. Branch off `dev` and open your pull request into `dev`.
- **`main`** is releases only. Don't open pull requests into `main` and don't push to it. I merge `dev` into `main` when it's ready to ship.

Every push to `dev` rebuilds the dev prerelease. Every merge into `main` publishes a new release, so `main` should only ever get changes that have been tested on `dev`.

## Versions

You don't need to touch the version number. Each release from `main` takes the latest release and adds one to the patch number (0.3.0 becomes 0.3.1).

For a bigger jump, set `version` in `module.json` higher than the latest release (for example `0.4.0`), and that release uses it.

## Before you open a pull request

1. Run the tests:

   ```
   node --test tests/*.mjs
   ```

2. Try your change in Foundry. Scratchpad supports v13 and v14, so check both if your change touches anything Foundry-specific (scenes, drawings, the canvas, dialogs).
3. If it involves other players (live strokes, private drawings, layers, card ownership), test with a second user logged in.
4. Keep the pull request to one change and say what you tested.

## Using AI

I use AI tools to help write code for this project. You're welcome to as well, as long as you've read the code, understand it, and tested it yourself before opening the pull request.
