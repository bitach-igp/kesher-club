// Injectable clock so expiry and "last used" copy are deterministic in tests.
import { createContext, useContext } from 'react';

export type Now = () => Date;
export const NowContext = createContext<Now>(() => new Date());
export const NowProvider = NowContext.Provider;
export const useNow = (): Now => useContext(NowContext);
