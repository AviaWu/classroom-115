const DOMAIN='classroom-115.local';

export function credentialsForLogin(account,pin){
    if(typeof pin!=='string' || !/^\d{4}$/.test(pin)) return null;
    if(account==='teacher') return {role:'teacher',studentId:null,email:`teacher@${DOMAIN}`,password:`c115-${pin}`};
    if(account==='test') return {role:'student',studentId:28,email:`test@${DOMAIN}`,password:`c115-${pin}`};
    const match=typeof account==='string' && account.match(/^student-(\d+)$/);
    const studentId=Number(match?.[1]);
    if(!Number.isInteger(studentId) || studentId<1 || studentId>26) return null;
    return {role:'student',studentId,email:`student-${studentId}@${DOMAIN}`,password:`c115-${pin}`};
}

export function accountForEmail(email){
    if(typeof email!=='string') return null;
    if(email===`teacher@${DOMAIN}`) return {role:'teacher',studentId:null};
    if(email===`test@${DOMAIN}`) return {role:'student',studentId:28};
    const match=email.match(new RegExp(`^student-(\\d+)@${DOMAIN.replace('.', '\\.')}$`));
    const studentId=Number(match?.[1]);
    return Number.isInteger(studentId) && studentId>=1 && studentId<=26 ? {role:'student',studentId} : null;
}
