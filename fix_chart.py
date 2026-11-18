import re

def fix_chart_and_app(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Replace the SVG hover dot & rings with an HTML-based indicator inside chartInteractiveWrap
    # So the dot is rendered in pure CSS pixels and never gets distorted by SVG scaling/aspect-ratio!
    old_svg_dots = """                                <!-- Hover: pulse ring + dot -->
                                <circle id="chartHoverGlow" cx="0" cy="0" r="18" fill="rgba(255,255,255,0.10)" class="opacity-0 transition-opacity"/>
                                <circle id="chartHoverRing" cx="0" cy="0" r="11" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="2" class="opacity-0 transition-opacity"/>
                                <line id="chartHoverLine" x1="0" y1="0" x2="0" y2="330" stroke="rgba(255,255,255,0.20)" stroke-width="1.5" stroke-dasharray="3 4" stroke-linecap="round" class="opacity-0 transition-opacity"/>
                                <circle id="chartHoverDot" cx="0" cy="0" r="6" fill="#ffffff" stroke="#0b0b0b" stroke-width="2.5" class="opacity-0 transition-opacity"/>
                              </svg>"""

    new_svg_dots = """                                <!-- Hover dashed guideline -->
                                <line id="chartHoverLine" x1="0" y1="0" x2="0" y2="330" stroke="rgba(255,255,255,0.20)" stroke-width="1.5" stroke-dasharray="3 4" stroke-linecap="round" class="opacity-0 transition-opacity"/>
                              </svg>
                              <!-- HTML Hover Dot (Perfect circle, not stretched by SVG preserveAspectRatio=none) -->
                              <div id="chartHoverDotWrap" class="absolute pointer-events-none opacity-0 transition-opacity z-10" style="width:0; height:0; transform:translate(-50%, -50%);">
                                <div class="relative flex items-center justify-center">
                                  <div class="absolute w-8 h-8 rounded-full bg-white/10 animate-ping opacity-75"></div>
                                  <div class="absolute w-6 h-6 rounded-full border border-white/40 bg-white/5"></div>
                                  <div class="size-3 rounded-full bg-white border-2 border-[#0b0b0b] shadow-[0_0_10px_rgba(255,255,255,0.8)]"></div>
                                </div>
                              </div>"""

    if old_svg_dots in content:
        content = content.replace(old_svg_dots, new_svg_dots)
        print(f'Replaced SVG hover dots with HTML dot wrap in {filepath}')
    else:
        print(f'Warning: old_svg_dots pattern not found directly in {filepath}')

    # 2. Update JS mousemove and mouseleave to position chartHoverDotWrap at (pointPixelX, pointPixelY)
    # Search for positioning code
    old_js_pos = """        // Position guideline & dot
        chartHoverLine.setAttribute('x1', closest.x);
        chartHoverLine.setAttribute('x2', closest.x);
        chartHoverLine.classList.remove('opacity-0');

        chartHoverDot.setAttribute('cx', closest.x);
        chartHoverDot.setAttribute('cy', closest.y);
        chartHoverDot.classList.remove('opacity-0');

        chartHoverGlow.setAttribute('cx', closest.x);
        chartHoverGlow.setAttribute('cy', closest.y);
        chartHoverGlow.classList.remove('opacity-0');
        var _hRing = document.getElementById('chartHoverRing');
        if (_hRing) { _hRing.setAttribute('cx', closest.x); _hRing.setAttribute('cy', closest.y); _hRing.classList.remove('opacity-0'); }"""

    new_js_pos = """        // Position guideline & dot
        chartHoverLine.setAttribute('x1', closest.x);
        chartHoverLine.setAttribute('x2', closest.x);
        chartHoverLine.classList.remove('opacity-0');

        const dotWrap = document.getElementById('chartHoverDotWrap');
        if (dotWrap) {
          dotWrap.style.left = `${pointPixelX}px`;
          dotWrap.style.top = `${pointPixelY}px`;
          dotWrap.classList.remove('opacity-0');
        }"""

    if old_js_pos in content:
        content = content.replace(old_js_pos, new_js_pos)
        print(f'Updated JS mousemove in {filepath}')
    else:
        print(f'Warning: old_js_pos not found in {filepath}')

    old_js_leave = """      chartInteractiveWrap.addEventListener('mouseleave', () => {
        chartHoverLine.classList.add('opacity-0');
        chartHoverDot.classList.add('opacity-0');
        chartHoverGlow.classList.add('opacity-0');
        chartTooltip.classList.add('opacity-0');
        var _hRingL = document.getElementById('chartHoverRing');
        if (_hRingL) _hRingL.classList.add('opacity-0');
      });"""

    new_js_leave = """      chartInteractiveWrap.addEventListener('mouseleave', () => {
        chartHoverLine.classList.add('opacity-0');
        const dotWrap = document.getElementById('chartHoverDotWrap');
        if (dotWrap) dotWrap.classList.add('opacity-0');
        chartTooltip.classList.add('opacity-0');
      });"""

    if old_js_leave in content:
        content = content.replace(old_js_leave, new_js_leave)
        print(f'Updated JS mouseleave in {filepath}')
    else:
        print(f'Warning: old_js_leave not found in {filepath}')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

fix_chart_and_app(r'C:\Users\olivi\Downloads\Rollbux\index.html')
fix_chart_and_app(r'C:\Users\olivi\Downloads\Rollbux\server\dashboard.html')
