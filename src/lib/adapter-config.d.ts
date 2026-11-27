// Typed instance settings (native in io-package.json)
export {};

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            uiAdapters: string;
            scriptAdapters: string;
            ignoreAdapters: string;
            include: string;
            exclude: string;
            confirmWindow: number;
            burstWindow: number;
            externalWindow: number;
            retentionDays: number;
            /** Outdoor values chosen by the user */
            contextValues: { id: string; kind: string }[];
            /** Presence and mode states chosen by the user (recorded on change, not exported) */
            modeValues: { id: string; kind: string }[];
            /** Record room temperature and humidity automatically */
            contextRooms: boolean;
        }
    }
}
