/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings, Settings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy, waitFor } from "@webpack";
import { ContextMenuApi, FluxDispatcher, Menu, React, UserStore } from "@webpack/common";
import { Channel } from "discord-types/general";

import { contextMenus } from "./components/contextMenu";
import { openCategoryModal, requireSettingsMenu } from "./components/CreateCategoryModal";
import { DEFAULT_CHUNK_SIZE } from "./constants";
import { canMoveCategory, canMoveCategoryInDirection, categories, Category, categoryLen, collapseCategory, getAllUncollapsedChannels, getSections, initCategories, isPinned, migrateData, moveCategory, removeCategory } from "./data";

interface ChannelComponentProps {
    children: React.ReactNode,
    channel: Channel,
    selected: boolean;
}

const headerClasses = findByPropsLazy("privateChannelsHeaderContainer");

const PrivateChannelSortStore = findStoreLazy("PrivateChannelSortStore") as { getPrivateChannelIds: () => string[]; };

export let instance: any;
export const forceUpdate = () => instance?.props?._forceUpdate?.();

// the flux property in definePlugin doenst fire, probably because startAt isnt Init
waitFor(["dispatch", "subscribe"], m => {
    m.subscribe("CONNECTION_OPEN", async () => {
        if (!Settings.plugins.PinDMs?.enabled) return;

        const id = UserStore.getCurrentUser()?.id;
        await initCategories(id);
        await migrateData(id);
        forceUpdate();
        // dont want to unsubscribe because if they switch accounts we want to reinit
    });
});


export const settings = definePluginSettings({
    sortDmsByNewestMessage: {
        type: OptionType.BOOLEAN,
        description: "Sort DMs by newest message",
        default: false,
        onChange: () => forceUpdate()
    },

    dmSectioncollapsed: {
        type: OptionType.BOOLEAN,
        description: "Collapse DM sections",
        default: false,
        onChange: () => forceUpdate()
    }
});

export default definePlugin({
    name: "PinDMs",
    description: "Allows you to pin private channels to the top of your DM list. To pin/unpin or reorder pins, right click DMs",
    authors: [Devs.Ven],

    settings,
    contextMenus,

    patches: [
        {
            find: ".privateChannelsHeaderContainer,",
            replacement: [
                // Init
                {
                    match: /(?<=componentDidMount\(\){).{1,100}scrollToChannel/,
                    replace: "$self._instance = this;$&"
                },
                {
                    // Filter out pinned channels from the private channel list
                    match: /(?<=\i,{channels:\i,)privateChannelIds:(\i)/,
                    replace: "privateChannelIds:$1.filter(c=>!$self.isPinned(c))"
                },
                {
                    // Insert the pinned channels to sections
                    match: /(?<=renderRow:this\.renderRow,)sections:\[.+?1\)]/,
                    replace: "...$self.makeProps(this,{$&})"
                },

                // Rendering
                {
                    match: /this\.renderDM=\(.+?(\i\.default),{channel.+?this.renderRow=(\i)=>{/,
                    replace: "$&if($self.isChannelIndex($2.section, $2.row))return $self.renderChannel($2.section,$2.row,$1);"
                },
                {
                    match: /this\.renderSection=(\i)=>{/,
                    replace: "$&if($self.isCategoryIndex($1.section))return $self.renderCategory($1);"
                },
                {
                    match: /(?<=span",{)className:\i\.headerText,/,
                    replace: "...$self.makeSpanProps(),$&"
                },

                // Fix Row Height
                {
                    match: /(?<=this\.getRowHeight=.{1,100}return 1===)\i/,
                    replace: "($&-$self.categoryLen())"
                },
                {
                    match: /this.getRowHeight=\((\i),(\i)\)=>{/,
                    replace: "$&if($self.isChannelHidden($1,$2))return 0;"
                },

                // Fix ScrollTo
                {
                    // Override scrollToChannel to properly account for pinned channels
                    match: /(?<=scrollTo\(\{to:\i\}\):\(\i\+=)(\d+)\*\(.+?(?=,)/,
                    replace: "$self.getScrollOffset(arguments[0],$1,this.props.padding,this.state.preRenderedChildren,$&)"
                },
                {
                    match: /(?<=scrollToChannel\(\i\){.{1,300})this\.props\.privateChannelIds/,
                    replace: "[...$&,...$self.getAllUncollapsedChannels()]"
                },

            ]
        },


        // forceUpdate moment
        // https://regex101.com/r/kDN9fO/1
        {
            find: ".FRIENDS},\"friends\"",
            replacement: {
                match: /(?<=\i=\i=>{).{1,100}premiumTabSelected.{1,800}showDMHeader:.+?,/,
                replace: "let forceUpdate = Vencord.Util.useForceUpdater();$&_forceUpdate:forceUpdate,"
            }
        },

        // Fix Alt Up/Down navigation
        {
            find: ".Routes.APPLICATION_STORE&&",
            replacement: {
                // channelIds = __OVERLAY__ ? stuff : [...getStaticPaths(),...channelIds)]
                match: /(?<=\i=__OVERLAY__\?\i:\[\.\.\.\i\(\),\.\.\.)\i/,
                // ....concat(pins).concat(toArray(channelIds).filter(c => !isPinned(c)))
                replace: "$self.getAllUncollapsedChannels().concat($&.filter(c=>!$self.isPinned(c)))"
            }
        },

        // fix alt+shift+up/down
        {
            find: ".getFlattenedGuildIds()],",
            replacement: {
                match: /(?<=\i===\i\.ME\?)\i\.\i\.getPrivateChannelIds\(\)/,
                replace: "$self.getAllUncollapsedChannels().concat($&.filter(c=>!$self.isPinned(c)))"
            }
        },
    ],
    sections: null as number[] | null,

    set _instance(i: any) {
        this.instance = i;
        instance = i;
    },

    isPinned,
    categoryLen,
    getSections,
    getAllUncollapsedChannels,

    start() {
        requireSettingsMenu();
    },

    makeProps(instance, { sections }: { sections: number[]; }) {
        this.sections = sections;

        this.sections.splice(1, 0, ...this.getPinCount(instance.props.privateChannelIds || []));

        if (this.instance?.props?.privateChannelIds?.length === 0) {
            this.sections[this.sections.length - 1] = 0;
        }

        return {
            sections: this.sections,
            chunkSize: this.getChunkSize(),
        };
    },

    makeSpanProps() {
        return {
            onClick: () => this.collapseDMList(),
            role: "button",
            style: { cursor: "pointer" }
        };
    },

    getChunkSize() {
        // the chunk size is the amount of rows (measured in pixels) that are rendered at once (probably)
        // the higher the chunk size, the more rows are rendered at once
        // also if the chunk size is 0 it will render everything at once

        const sections = this.getSections();
        const sectionHeaderSizePx = sections.length * 40;
        // (header heights + DM heights + DEFAULT_CHUNK_SIZE) * 1.5
        // we multiply everything by 1.5 so it only gets unmounted after the entire list is off screen
        return (sectionHeaderSizePx + sections.reduce((acc, v) => acc += v + 44, 0) + DEFAULT_CHUNK_SIZE) * 1.5;
    },

    getPinCount(channelIds: string[]) {
        return channelIds.length ? this.getSections() : [];
    },

    isCategoryIndex(sectionIndex: number) {
        return this.sections && sectionIndex > 0 && sectionIndex < this.sections.length - 1;
    },

    isChannelIndex(sectionIndex: number, channelIndex: number) {
        if (settings.store.dmSectioncollapsed && sectionIndex !== 0)
            return true;
        const cat = categories[sectionIndex - 1];
        return this.isCategoryIndex(sectionIndex) && (cat.channels.length === 0 || cat?.channels[channelIndex]);
    },

    isDMSectioncollapsed() {
        return settings.store.dmSectioncollapsed;
    },

    collapseDMList() {
        // console.log("HI");
        settings.store.dmSectioncollapsed = !settings.store.dmSectioncollapsed;
        forceUpdate();
    },

    isChannelHidden(categoryIndex: number, channelIndex: number) {
        if (categoryIndex === 0) return false;

        if (settings.store.dmSectioncollapsed && this.getSections().length + 1 === categoryIndex)
            return true;

        if (!this.instance || !this.isChannelIndex(categoryIndex, channelIndex)) return false;

        const category = categories[categoryIndex - 1];
        if (!category) return false;

        return category.collapsed && this.instance.props.selectedChannelId !== category.channels[channelIndex];
    },

    getScrollOffset(channelId: string, rowHeight: number, padding: number, preRenderedChildren: number, originalOffset: number) {
        if (!isPinned(channelId))
            return (
                (rowHeight + padding) * 2 // header
                + rowHeight * this.getAllUncollapsedChannels().length // pins
                + originalOffset // original pin offset minus pins
            );

        return rowHeight * (this.getAllUncollapsedChannels().indexOf(channelId) + preRenderedChildren) + padding;
    },

    renderCategory({ section }: { section: number; }) {
        const category = categories[section - 1];

        if (!category) return null;

        return (
            <h2
                className={classes(headerClasses.privateChannelsHeaderContainer, "vc-pindms-section-container", category.collapsed ? "vc-pindms-collapsed" : "")}
                style={{ color: `#${category.color.toString(16).padStart(6, "0")}` }}
                onClick={async () => {
                    await collapseCategory(category.id, !category.collapsed);
                    forceUpdate();
                }}
                onContextMenu={e => {
                    ContextMenuApi.openContextMenu(e, () => (
                        <Menu.Menu
                            navId="vc-pindms-header-menu"
                            onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
                            color="danger"
                            aria-label="Pin DMs Category Menu"
                        >
                            <Menu.MenuItem
                                id="vc-pindms-edit-category"
                                label="Edit Category"
                                action={() => openCategoryModal(category.id, null)}
                            />

                            {
                                canMoveCategory(category.id) && (
                                    <>
                                        {
                                            canMoveCategoryInDirection(category.id, -1) && <Menu.MenuItem
                                                id="vc-pindms-move-category-up"
                                                label="Move Up"
                                                action={() => moveCategory(category.id, -1).then(() => forceUpdate())}
                                            />
                                        }
                                        {
                                            canMoveCategoryInDirection(category.id, 1) && <Menu.MenuItem
                                                id="vc-pindms-move-category-down"
                                                label="Move Down"
                                                action={() => moveCategory(category.id, 1).then(() => forceUpdate())}
                                            />
                                        }
                                    </>

                                )
                            }

                            <Menu.MenuSeparator />
                            <Menu.MenuItem
                                id="vc-pindms-delete-category"
                                color="danger"
                                label="Delete Category"
                                action={() => removeCategory(category.id).then(() => forceUpdate())}
                            />


                        </Menu.Menu>
                    ));
                }}
            >
                <span className={headerClasses.headerText}>
                    {category?.name ?? "uh oh"}
                </span>
                <svg className="vc-pindms-collapse-icon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z"></path>
                </svg>
            </h2>
        );
    },

    renderChannel(sectionIndex: number, index: number, ChannelComponent: React.ComponentType<ChannelComponentProps>) {
        const { channel, category } = this.getChannel(sectionIndex, index, this.instance.props.channels);

        if (!channel || !category) return null;
        if (this.isChannelHidden(sectionIndex, index)) return null;

        return (
            <ChannelComponent
                channel={channel}
                selected={this.instance.props.selectedChannelId === channel.id}
            >
                {channel.id}
            </ChannelComponent>
        );
    },

    getChannel(sectionIndex: number, index: number, channels: Record<string, Channel>) {
        const category = categories[sectionIndex - 1];
        if (!category) return { channel: null, category: null };

        const channelId = this.getCategoryChannels(category)[index];

        return { channel: channels[channelId], category };
    },

    getCategoryChannels(category: Category) {
        if (category.channels.length === 0) return [];

        if (settings.store.sortDmsByNewestMessage) {
            return PrivateChannelSortStore.getPrivateChannelIds().filter(c => category.channels.includes(c));
        }

        return category?.channels ?? [];
    }
});
