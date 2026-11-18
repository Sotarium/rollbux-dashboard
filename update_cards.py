def update_cards_height(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # We want:
    # 1. Results & Rain Rewards on Left, Accounts on Right, with equal height cards and clean scrollable inner lists when full.
    # The grid container:
    old_grid = '<div class="grid grid-cols-1 lg:grid-cols-2 gap-5 w-full items-start">'
    new_grid = '<div class="grid grid-cols-1 lg:grid-cols-2 gap-5 w-full items-stretch">'

    if old_grid in content:
        content = content.replace(old_grid, new_grid)
        print(f'Updated grid to items-stretch in {filepath}')
    else:
        print(f'Warning: old_grid not found in {filepath}')

    # Let's inspect the two columns:
    # Left Column: Results & Rain Rewards
    # Right Column: Accounts Card
    # If the user says:
    # "make theses 2 cards same height whatever if they are empty or ot if accs sectio becope too tight make it go higher"
    # The right column card (Accounts Card) should have:
    # min-h-[460px] (or flex-1 h-full) and accountsQuickList with flex-1 overflow-y-auto max-h-[600px]
    # And the left column cards or left card:
    # If Left Column has Results + Rain Rewards, the right column matches the total height of Left Column!
    # OR if Results and Accounts are the 2 cards side by side (with Rain Rewards combined or underneath),
    # let's make Accounts card flex-1 h-full min-h-[480px] so it matches the left side perfectly!

    old_right_col = """                        <!-- Right Column: Accounts Card -->
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
                        </div>"""

    new_right_col = """                        <!-- Right Column: Accounts Card -->
                        <div class="flex flex-col w-full h-full">
                          <div class="dv-card flex flex-col gap-3 p-5 h-full min-h-[480px]">
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
                            <!-- Scrollable inner account list with ample height; expands taller automatically if needed -->
                            <div id="accountsQuickList" class="flex flex-col gap-2 w-full pt-1 flex-1 overflow-y-auto max-h-[580px] pr-1">
                            </div>
                          </div>
                        </div>"""

    if old_right_col in content:
        content = content.replace(old_right_col, new_right_col)
        print(f'Successfully updated right column in {filepath}')
    else:
        print(f'Warning: old_right_col not found in {filepath}')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

update_cards_height(r'C:\Users\olivi\Downloads\Rollbux\index.html')
update_cards_height(r'C:\Users\olivi\Downloads\Rollbux\server\dashboard.html')
