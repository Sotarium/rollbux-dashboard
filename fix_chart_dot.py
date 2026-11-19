def fix_chart_dot_and_clamping(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Replace the overly complex/ringed HTML dot with a clean, sleek, perfectly centered white dot with subtle glow
    old_dot_html = """                              <!-- HTML Hover Dot (Perfect circle, not stretched by SVG preserveAspectRatio=none) -->
                              <div id="chartHoverDotWrap" class="absolute pointer-events-none opacity-0 transition-opacity z-10" style="width:0; height:0; transform:translate(-50%, -50%);">
                                <div class="relative flex items-center justify-center">
                                  <div class="absolute w-8 h-8 rounded-full bg-white/10 animate-ping opacity-75"></div>
                                  <div class="absolute w-6 h-6 rounded-full border border-white/40 bg-white/5"></div>
                                  <div class="size-3 rounded-full bg-white border-2 border-[#0b0b0b] shadow-[0_0_10px_rgba(255,255,255,0.8)]"></div>
                                </div>
                              </div>"""

    new_dot_html = """                              <!-- HTML Hover Dot (Clean, sleek, perfectly circular) -->
                              <div id="chartHoverDotWrap" class="absolute pointer-events-none opacity-0 transition-opacity z-20" style="width:14px; height:14px; border-radius:9999px; background:#ffffff; border:2.5px solid #0b0b0b; box-shadow:0 0 12px 2px rgba(255,255,255,0.7); transform:translate(-50%, -50%);"></div>"""

    if old_dot_html in content:
        content = content.replace(old_dot_html, new_dot_html)
        print(f'Replaced dot markup in {filepath}')
    else:
        print(f'Warning: old_dot_html not found in {filepath}')

    # 2. Update the mousemove listener:
    # - Correct pointPixelX/pointPixelY calculation clamped strictly inside chart bounds
    # - Smooth horizontal interpolation or clamped snapping
    # - Clamped dot positioning so it never goes outside the chart borders (0 to rect.width, 0 to rect.height)
    # - Clamped dashed guideline (setAttribute x1, x2 within [0, 744])
    old_mousemove = """        const pointPixelX = (closest.x / 744) * rect.width;
        const pointPixelY = (closest.y / 330) * rect.height;

        // Position guideline & dot
        chartHoverLine.setAttribute('x1', closest.x);
        chartHoverLine.setAttribute('x2', closest.x);
        chartHoverLine.classList.remove('opacity-0');

        const dotWrap = document.getElementById('chartHoverDotWrap');
        if (dotWrap) {
          dotWrap.style.left = `${pointPixelX}px`;
          dotWrap.style.top = `${pointPixelY}px`;
          dotWrap.classList.remove('opacity-0');
        }"""

    new_mousemove = """        // Clamp SVG X to [0, 744] so hover line and dot never cross chart borders
        const clampedSvgX = Math.max(0, Math.min(744, closest.x));
        const clampedSvgY = Math.max(0, Math.min(330, closest.y));

        const pointPixelX = Math.max(0, Math.min(rect.width, (clampedSvgX / 744) * rect.width));
        const pointPixelY = Math.max(0, Math.min(rect.height, (clampedSvgY / 330) * rect.height));

        // Position guideline & dot
        chartHoverLine.setAttribute('x1', clampedSvgX);
        chartHoverLine.setAttribute('x2', clampedSvgX);
        chartHoverLine.classList.remove('opacity-0');

        const dotWrap = document.getElementById('chartHoverDotWrap');
        if (dotWrap) {
          dotWrap.style.left = `${pointPixelX}px`;
          dotWrap.style.top = `${pointPixelY}px`;
          dotWrap.classList.remove('opacity-0');
        }"""

    if old_mousemove in content:
        content = content.replace(old_mousemove, new_mousemove)
        print(f'Updated mousemove clamping in {filepath}')
    else:
        print(f'Warning: old_mousemove not found in {filepath}')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

fix_chart_dot_and_clamping(r'C:\Users\olivi\Downloads\Rollbux\index.html')
fix_chart_dot_and_clamping(r'C:\Users\olivi\Downloads\Rollbux\server\dashboard.html')
