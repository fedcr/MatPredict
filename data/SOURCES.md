# Reference data sources

Records tagged `Lit:` in `app.js` come from published measurements. Values are tensile strength in MPa as reported by each source. Test method, print orientation and material grade differ between sources, so treat them as rough anchors, not a calibrated dataset. Colour is unknown for all of them and left empty.

| Record | Value | Source |
|---|---|---|
| Neat PLA, printed | 49.99 MPa | Forests 2023, "PLA/Coffee Grounds Composite for 3D Printing" (https://www.mdpi.com/1999-4907/14/2/367) |
| PLA + 3% coffee grounds | 51.28 MPa | same |
| PLA + 7% coffee grounds | 26.45 MPa | same |
| PLA + 20% wood powder | 36.7 MPa | Vendor datasheet, PLA wood filament (https://filament2print.com/en/wood-stone-metal/2488-pla-wood-r3d.html) |
| PETG + 15% carbon fiber | 48.7 MPa (XY) | Vendor datasheet for PETG-CF, 15% carbon fiber; Z direction 24.1 MPa |
| PETG + 30% carbon fiber | 60 MPa | E3S Web of Conferences 2024 (https://www.e3s-conferences.org/articles/e3sconf/pdf/2024/118/e3sconf_sne2-2024_01014.pdf) |
| Recycled PETG 70% + PLA 30% | 7.47 MPa | Zahro et al., Sinergi (https://publikasi.mercubuana.ac.id/index.php/sinergi/article/view/33650); elongation 1.58% |

Force units logged by users (kg, N) are converted with a 1.75 mm filament cross-section of 2.405 mm2. This is an assumption.
