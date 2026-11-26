# The visual tests' fonts

The only fonts the visual tests' browser sees, through [fonts.conf](fonts.conf): a screenshot does not depend on
the fonts a machine has. [spec/web.md](../../../spec/web.md#visual-tests).

- `DejaVuSans.ttf`, `DejaVuSans-Bold.ttf`: every font the page asks for (`system-ui`, `sans-serif`)
- `DejaVuSansMono.ttf`, `DejaVuSansMono-Bold.ttf`: a monospace one (`ui-monospace`, `monospace`)

[DejaVu fonts](https://dejavu-fonts.github.io/) 2.37, under [their licence](LICENSE), subset to the characters
the page shows (Latin, general punctuation, arrows), with [fontTools](https://github.com/fonttools/fonttools):
```sh
for f in DejaVuSans DejaVuSans-Bold DejaVuSansMono DejaVuSansMono-Bold; do
  python3 -m fontTools.subset /usr/share/fonts/truetype/dejavu/$f.ttf --layout-features='*' --output-file=$f.ttf \
    --unicodes='U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2190-2193'
done
```
A character outside them is not drawn, the same on every machine: subset again with it added.
