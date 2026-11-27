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
            retentionDays: number;
        }
    }
}
