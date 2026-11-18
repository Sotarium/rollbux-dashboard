import re

two_col_layout = """                      <!-- 2-Column Split: Results (Left) and Accounts (Right) to make page less tall -->
                      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 w-full items-start">

                        <!-- Left Column: Results & Rain Rewards -->
                        <div class="flex flex-col gap-5 w-full">
                          <!-- Results Feed Card -->
                          <div class="dv-card flex flex-col gap-3 p-5">
                            <div class="flex items-center justify-between">
                              <h3 class="text-[17px] font-bold text-white tracking-tight">Results</h3>
                              <button type="button" onclick="clearResultsFeed()" class="dv-pill inactive" style="height:28px; padding:0 12px; font-size:12px;">Clear</button>
                            </div>

                            <!-- Account Picker matching Auto Upgrader style -->
                            <button type="button" id="resultsAccountBtn" onclick="openAccountSelectorModal('results')" class="dv-field flex items-center justify-between px-3 hover:border-white/20 transition cursor-pointer w-full" style="height:42px;">
                              <span class="text-[12px] font-semibold text-[#8f8f8f]">Account</span>
                              <span id="resultsAccountLabel" class="text-[13px] font-semibold text-white truncate ml-2">All Accounts</span>
                            </button>

                            <div id="resultsFeedList" class="flex flex-col gap-2 w-full pt-1"></div>
                            <!-- Pagination -->
                            <div id="resultsPaginationWrap" class="hidden items-center justify-between pt-1">
                              <button type="button" onclick="resultsPage=Math.max(1,resultsPage-1);renderResultsFeed()" class="dv-pill inactive" style="height:26px;padding:0 12px;font-size:11px;">Prev</button>
                              <span id="resultsPageLabel" class="text-[11px]  text-[#8f8f8f]">1 / 1</span>
                              <button type="button" onclick="resultsPage=Math.min(resultsTotalPages,resultsPage+1);renderResultsFeed()" class="dv-pill inactive" style="height:26px;padding:0 12px;font-size:11px;">Next</button>
                            </div>
                          </div>

                          <!-- Rain Rewards Card -->
                          <div class="dv-card flex flex-col gap-3 p-5">
                            <div class="flex items-center justify-between">
                              <h3 class="text-[17px] font-bold text-white tracking-tight">Rain Rewards</h3>
                              <button type="button" onclick="clearRainRewards()" class="dv-pill inactive" style="height:28px;padding:0 12px;font-size:12px;">Clear</button>
                            </div>

                            <!-- Account Picker matching Auto Upgrader style -->
                            <button type="button" id="rainAccountBtn" onclick="openAccountSelectorModal('rain')" class="dv-field flex items-center justify-between px-3 hover:border-white/20 transition cursor-pointer w-full" style="height:42px;">
                              <span class="text-[12px] font-semibold text-[#8f8f8f]">Account</span>
                              <span id="rainAccountLabel" class="text-[13px] font-semibold text-white truncate ml-2">All Accounts</span>
                            </button>

                            <div id="rainRewardsList" class="flex flex-col gap-2 w-full pt-1">
                              <div class="flex h-[60px] items-center justify-center text-xs text-[#8f8f8f]">Loading rain rewards...</div>
                            </div>
                            <!-- Pagination -->
                            <div id="rainPaginationWrap" class="hidden items-center justify-between pt-1">
                              <button type="button" onclick="rainPage=Math.max(1,rainPage-1);renderRainRewards()" class="dv-pill inactive" style="height:26px;padding:0 12px;font-size:11px;">Prev</button>
                              <span id="rainPageLabel" class="text-[11px]  text-[#8f8f8f]">1 / 1</span>
                              <button type="button" onclick="rainPage=Math.min(rainTotalPages,rainPage+1);renderRainRewards()" class="dv-pill inactive" style="height:26px;padding:0 12px;font-size:11px;">Next</button>
                            </div>
                          </div>
                        </div>

                        <!-- Right Column: Accounts Card -->
                        <div class="flex flex-col gap-5 w-full">
                          <div class="dv-card flex flex-col gap-3 p-5">
                            <div class="flex items-center justify-between">
                              <h3 class="text-[17px] font-bold text-white tracking-tight">Accounts</h3>
                              <div class="flex items-center gap-2 select-none">
                                <button id="refreshAccountsBtn" onclick="refreshAccountsList()" type="button" class="dv-pill inactive" style="height:32px; padding:0 10px;" title="Refresh">
                                  <svg class="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                </button>
                                <button id="addAccountBtn" onclick="openFarmerModal()" type="button" class="dv-pill active" style="height:32px; padding:0 14px;">
                                  <svg class="size-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
                                  <span>Add</span>
                                </button>
                              </div>
                            </div>
                            <div id="accountsQuickList" class="flex flex-col gap-2 w-full pt-1">
                            </div>
                          </div>
                        </div>

                      </div>"""

custom_scrollbar_css = """
  /* Vibecoded Custom Scrollbar */
  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
    border-radius: 9999px;
    transition: background 0.2s ease;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.25);
  }
  * {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.14) transparent;
  }
"""

def process_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Update Scrollbar CSS
    if '/* Vibecoded Custom Scrollbar */' not in content:
        if '</style>' in content:
            content = content.replace('</style>', custom_scrollbar_css + '\n</style>', 1)
            print(f'Added custom scrollbar CSS to {filepath}')

    # 2. Update layout: from Accounts Card to end of Rain Rewards Card
    start_str = '<!-- Accounts Card matching accountsCard in SiteView -->'
    end_str = '<!-- Rain Rewards Card -->'
    
    s_idx = content.find(start_str)
    e_idx = content.find(end_str, s_idx)
    
    if s_idx != -1 and e_idx != -1:
        # Find closing div of Rain Rewards Card
        # It ends after rainPaginationWrap ... </div></div>
        sub = content[e_idx:]
        # Find after rainPaginationWrap
        wrap_idx = sub.find('id="rainPaginationWrap"')
        # Now find the closing </div> of card
        # Next </div> closes wrap, next closes card
        d1 = sub.find('</div>', wrap_idx)
        d2 = sub.find('</div>', d1 + 6)
        total_end = e_idx + d2 + 6
        
        old_chunk = content[s_idx:total_end]
        print(f'Replacing chunk in {filepath} (len: {len(old_chunk)})')
        content = content[:s_idx] + two_col_layout.strip() + content[total_end:]
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'Successfully updated layout in {filepath}')
    else:
        print(f'Markers not found in {filepath}: s_idx={s_idx}, e_idx={e_idx}')

process_file(r'C:\Users\olivi\Downloads\Rollbux\index.html')
process_file(r'C:\Users\olivi\Downloads\Rollbux\server\dashboard.html')
