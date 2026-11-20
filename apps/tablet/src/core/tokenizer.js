import {Tiktoken} from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
let encoder;
export function countTokens(text){encoder??=new Tiktoken(ranks);return encoder.encode(String(text),[],[]).length}
